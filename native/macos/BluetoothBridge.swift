import Foundation
import CoreBluetooth

// Private stdin/stdout JSONL protocol. This helper never interprets Neo packets,
// acknowledges pen transfers, opens a network socket, or writes application data.
private let wireVersion = 1
private let maxLineBytes = 1_048_576

private func emit(_ value: [String: Any]) {
    var message = value
    message["version"] = wireVersion
    guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    FileHandle.standardOutput.write(data + Data([10]))
}
private func reply(_ id: Int, _ result: [String: Any] = [:]) { emit(["id": id, "ok": true, "result": result]) }
private func reject(_ id: Int, _ error: String) { emit(["id": id, "ok": false, "error": error]) }
private func normalizedUUID(_ value: String) -> String {
    let lower = value.lowercased()
    return lower.count == 4 ? "0000\(lower)-0000-1000-8000-00805f9b34fb" : lower
}
private func authorizationName() -> String {
    switch CBManager.authorization {
    case .allowedAlways: return "allowed"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

private struct PendingWrite {
    let id: Int
    let chunks: [Data]
    var next = 0
}

private final class BluetoothBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private var central: CBCentralManager?
    private var serviceUUIDs: Set<String> = []
    private var writeUUIDs: Set<String> = []
    private var notifyUUIDs: Set<String> = []
    private var nameFragments: [String] = []
    private var initialization: [Int] = []
    private var peripherals: [String: CBPeripheral] = [:]
    private var discovered: [String: [String: Any]] = [:]
    private var scanRequest: Int?
    private var scanTimer: DispatchWorkItem?
    private var peripheral: CBPeripheral?
    private var connectionID: String?
    private var connectRequest: Int?
    private var disconnectRequest: Int?
    private var pendingServices = Set<ObjectIdentifier>()
    private var pairs: [(CBCharacteristic, CBCharacteristic)] = []
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBCharacteristic?
    private var notificationReady = false
    private var writing: PendingWrite?
    private var writeType: CBCharacteristicWriteType = .withResponse

    func handle(_ request: [String: Any]) {
        guard let id = request["id"] as? Int, id > 0, request["version"] as? Int == wireVersion,
              let command = request["command"] as? String else {
            emit(["event": "fatal", "error": "Invalid Bluetooth bridge request"])
            exit(1)
        }
        switch command {
        case "initialize":
            guard let services = request["serviceUuids"] as? [String], !services.isEmpty,
                  let writes = request["writeUuids"] as? [String], !writes.isEmpty,
                  let notifications = request["notifyUuids"] as? [String], !notifications.isEmpty,
                  let names = request["nameFragments"] as? [String] else { reject(id, "Missing Bluetooth UUID configuration"); return }
            serviceUUIDs = Set(services.map(normalizedUUID))
            writeUUIDs = Set(writes.map(normalizedUUID))
            notifyUUIDs = Set(notifications.map(normalizedUUID))
            nameFragments = names.map { $0.lowercased() }
            initialization.append(id)
            if central == nil { central = CBCentralManager(delegate: self, queue: .main) }
            else { finishInitialization() }
        case "devices":
            guard requirePoweredOn(id) else { return }
            reply(id, ["devices": deviceList()])
        case "scan":
            guard requirePoweredOn(id) else { return }
            guard scanRequest == nil else { reject(id, "A Bluetooth scan is already active"); return }
            guard let milliseconds = request["durationMs"] as? Int, (1000...30000).contains(milliseconds) else { reject(id, "Scan duration must be 1000–30000 ms"); return }
            discovered = discovered.filter { $0.key == peripheral?.identifier.uuidString }
            scanRequest = id
            // Some supported pens advertise their name without a service UUID.
            central!.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            let timer = DispatchWorkItem { [weak self] in
                guard let self = self, self.scanRequest == id else { return }
                self.central?.stopScan()
                self.scanRequest = nil
                self.scanTimer = nil
                reply(id, ["devices": self.deviceList()])
            }
            scanTimer = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(milliseconds), execute: timer)
        case "connect":
            guard requirePoweredOn(id) else { return }
            guard peripheral == nil else { reject(id, "A Bluetooth connection is already active or pending"); return }
            guard let deviceID = request["deviceId"] as? String, let target = peripherals[deviceID],
                  let token = request["connectionId"] as? String, !token.isEmpty else { reject(id, "Pen not found; scan again before connecting"); return }
            peripheral = target
            connectionID = token
            connectRequest = id
            target.delegate = self
            central!.connect(target, options: nil)
        case "disconnect":
            guard disconnectRequest == nil else { reject(id, "A disconnect is already pending"); return }
            guard let target = peripheral else { reply(id); return }
            disconnectRequest = id
            central?.cancelPeripheralConnection(target)
        case "write":
            guard let target = peripheral, target.state == .connected, notificationReady,
                  request["connectionId"] as? String == connectionID, let characteristic = writeCharacteristic else { reject(id, "Pen is not connected"); return }
            guard writing == nil else { reject(id, "A Bluetooth write is already active"); return }
            guard let encoded = request["data"] as? String, let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= 65536 else { reject(id, "Invalid Bluetooth write data"); return }
            writeType = characteristic.properties.contains(.write) ? .withResponse : .withoutResponse
            // Retain conservative 20-byte writes and serialize every full frame.
            let size = min(20, target.maximumWriteValueLength(for: writeType))
            guard size > 0 else { reject(id, "Bluetooth characteristic has no write capacity"); return }
            let chunks = stride(from: 0, to: data.count, by: size).map { data.subdata(in: $0..<min($0 + size, data.count)) }
            writing = PendingWrite(id: id, chunks: chunks)
            pumpWrite()
        default: reject(id, "Unsupported Bluetooth bridge command")
        }
    }

    private func stateError() -> String? {
        guard let manager = central else { return "Bluetooth has not been initialized" }
        switch manager.state {
        case .poweredOn: return nil
        case .poweredOff: return "Bluetooth is turned off. Enable Bluetooth in System Settings, then Retry Bluetooth."
        case .unauthorized: return "Bluetooth permission denied. Allow InkRelay Bluetooth (or the application launching it) in System Settings → Privacy & Security → Bluetooth, then Retry Bluetooth."
        case .unsupported: return "This Mac does not support Bluetooth Low Energy."
        case .resetting: return "macOS Bluetooth is resetting; Retry Bluetooth shortly."
        case .unknown: return "macOS Bluetooth is starting; allow the permission prompt if shown, then Retry Bluetooth."
        @unknown default: return "Unknown macOS Bluetooth state"
        }
    }
    private func requirePoweredOn(_ id: Int) -> Bool {
        if let error = stateError() { reject(id, error); return false }
        return true
    }
    private func finishInitialization() {
        guard let manager = central, manager.state != .unknown, manager.state != .resetting else { return }
        let pending = initialization
        initialization = []
        for id in pending {
            if let error = stateError() { reject(id, error) }
            else { reply(id, ["adapterName": "macOS Core Bluetooth"]) }
        }
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        finishInitialization()
        if central.state != .poweredOn {
            if let id = scanRequest { scanRequest = nil; scanTimer?.cancel(); scanTimer = nil; reject(id, stateError()!) }
            if peripheral != nil { clearConnection(stateError() ?? "Bluetooth unavailable") }
        }
    }
    private func deviceList() -> [[String: Any]] {
        discovered.values.map { info in
            var item = info
            item["connected"] = (item["deviceId"] as? String == peripheral?.identifier.uuidString && notificationReady)
            return item
        }.sorted { ($0["rssi"] as? Int ?? -999) > ($1["rssi"] as? Int ?? -999) }
    }
    func centralManager(_ central: CBCentralManager, didDiscover target: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let name = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? target.name ?? "Unknown pen"
        let advertised = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []) + (advertisementData[CBAdvertisementDataOverflowServiceUUIDsKey] as? [CBUUID] ?? [])
        let uuids = advertised.map { normalizedUUID($0.uuidString) }
        guard !serviceUUIDs.isDisjoint(with: uuids) || nameFragments.contains(where: { name.lowercased().contains($0) }) else { return }
        let key = target.identifier.uuidString
        peripherals[key] = target
        discovered[key] = ["deviceId": key, "name": name, "rssi": RSSI.intValue, "serviceUuids": uuids]
    }
    func centralManager(_ central: CBCentralManager, didConnect target: CBPeripheral) {
        guard target === peripheral, disconnectRequest == nil else { central.cancelPeripheralConnection(target); return }
        target.discoverServices(serviceUUIDs.map { CBUUID(string: $0) })
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect target: CBPeripheral, error: Error?) {
        guard target === peripheral else { return }
        clearConnection(error?.localizedDescription ?? "Could not connect to the pen")
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral target: CBPeripheral, error: Error?) {
        guard target === peripheral else { return }
        clearConnection(error?.localizedDescription ?? "Pen disconnected from macOS Bluetooth")
    }
    func peripheral(_ target: CBPeripheral, didDiscoverServices error: Error?) {
        guard target === peripheral, disconnectRequest == nil else { return }
        if let error = error { failConnection(error.localizedDescription); return }
        let services = (target.services ?? []).filter { serviceUUIDs.contains(normalizedUUID($0.uuid.uuidString)) }
        guard !services.isEmpty else { failConnection("Pen does not expose a supported BLE service"); return }
        pendingServices = Set(services.map { ObjectIdentifier($0) })
        for service in services { target.discoverCharacteristics(nil, for: service) }
    }
    func peripheral(_ target: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard target === peripheral, disconnectRequest == nil else { return }
        pendingServices.remove(ObjectIdentifier(service))
        if error == nil {
            let characteristics = service.characteristics ?? []
            let writer = characteristics.first { writeUUIDs.contains(normalizedUUID($0.uuid.uuidString)) && (!$0.properties.intersection([.write, .writeWithoutResponse]).isEmpty) }
            let notifier = characteristics.first { notifyUUIDs.contains(normalizedUUID($0.uuid.uuidString)) && (!$0.properties.intersection([.notify, .indicate]).isEmpty) }
            if let writer = writer, let notifier = notifier { pairs.append((writer, notifier)) }
        }
        guard pendingServices.isEmpty else { return }
        guard let pair = pairs.first else { failConnection("Pen does not expose Neo protocol-v2 write and notification characteristics"); return }
        writeCharacteristic = pair.0
        notifyCharacteristic = pair.1
        target.setNotifyValue(true, for: pair.1)
    }
    func peripheral(_ target: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard target === peripheral, characteristic === notifyCharacteristic, disconnectRequest == nil else { return }
        guard error == nil, characteristic.isNotifying else { failConnection(error?.localizedDescription ?? "Could not subscribe to pen notifications"); return }
        notificationReady = true
        if let id = connectRequest { connectRequest = nil; reply(id) }
    }
    func peripheral(_ target: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard target === peripheral, characteristic === notifyCharacteristic, notificationReady, disconnectRequest == nil, let token = connectionID else { return }
        if let error = error { failConnection(error.localizedDescription); return }
        if let data = characteristic.value, !data.isEmpty { emit(["event": "data", "connectionId": token, "data": data.base64EncodedString()]) }
    }
    private func pumpWrite() {
        guard let target = peripheral, let characteristic = writeCharacteristic, notificationReady, disconnectRequest == nil else { return }
        while var job = writing {
            if job.next == job.chunks.count { writing = nil; reply(job.id); return }
            if writeType == .withoutResponse && !target.canSendWriteWithoutResponse { return }
            let chunk = job.chunks[job.next]
            job.next += 1
            writing = job
            target.writeValue(chunk, for: characteristic, type: writeType)
            if writeType == .withResponse { return }
        }
    }
    func peripheral(_ target: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard target === peripheral, characteristic === writeCharacteristic, writeType == .withResponse else { return }
        if let error = error { failConnection(error.localizedDescription); return }
        pumpWrite()
    }
    func peripheralIsReady(toSendWriteWithoutResponse target: CBPeripheral) {
        if target === peripheral { pumpWrite() }
    }
    private func failConnection(_ reason: String) {
        if let target = peripheral { central?.cancelPeripheralConnection(target) }
        // Do not permit another connection until the cancellation callback arrives.
        notificationReady = false
        if let id = connectRequest { connectRequest = nil; reject(id, reason) }
        if let job = writing { writing = nil; reject(job.id, reason) }
    }
    private func clearConnection(_ reason: String) {
        let token = connectionID
        peripheral?.delegate = nil
        peripheral = nil
        connectionID = nil
        notificationReady = false
        writeCharacteristic = nil
        notifyCharacteristic = nil
        pendingServices = []
        pairs = []
        if let id = connectRequest { connectRequest = nil; reject(id, reason) }
        if let job = writing { writing = nil; reject(job.id, reason) }
        if let id = disconnectRequest { disconnectRequest = nil; reply(id) }
        if let token = token { emit(["event": "disconnected", "connectionId": token, "reason": reason]) }
    }
}

if CommandLine.arguments.contains("--probe") {
    // Does not instantiate CBCentralManager or trigger a permission request.
    emit(["authorization": authorizationName(), "platform": "macOS Core Bluetooth"])
} else {
    let bridge = BluetoothBridge()
    DispatchQueue.global(qos: .userInitiated).async {
        while let line = readLine() {
            guard line.utf8.count <= maxLineBytes, let data = line.data(using: .utf8),
                  let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                DispatchQueue.main.async { emit(["event": "fatal", "error": "Invalid Bluetooth bridge JSON"]); exit(1) }
                return
            }
            DispatchQueue.main.async { bridge.handle(request) }
        }
        // Closing the parent's pipe ends the helper; no pen commands are sent.
        DispatchQueue.main.async { exit(0) }
    }
    RunLoop.main.run()
}
