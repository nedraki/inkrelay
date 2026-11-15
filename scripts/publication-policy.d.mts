export function isPublicSource(path: string): boolean;
export function scanPublicText(path: string, text: string, privateMarkers?: string[]): {path: string; line?: number; kind: string}[];
export function isReviewedImage(path: string): boolean;
export function scanReviewedImage(path: string, bytes: Uint8Array): {path: string; kind: string}[];
