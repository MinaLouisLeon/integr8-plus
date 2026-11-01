/** Types for `bundle.mjs`, which the end-to-end suite runs before starting the program. */
export declare function productVersion(): string;
export declare const BUNDLE: string;
export declare function bundle(): Promise<{ version: string; file: string }>;
