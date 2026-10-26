/** The image types a logo file may have, keyed by its lowercase extension. */
export const viewerLogoMediaTypes = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
} as const;

/** One media type a logo file is served with. */
export type ViewerLogoMediaType =
  (typeof viewerLogoMediaTypes)[keyof typeof viewerLogoMediaTypes];

/** The largest logo file the server reads into memory. */
export const viewerLogoMaximumBytes = 256 * 1024;

/** Where the viewer logo's image comes from. */
export type ViewerLogoSource =
  | {
    /** The file's bytes, read once at startup. */
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly kind: "file";
    readonly mediaType: ViewerLogoMediaType;
    /** The absolute path the operator configured, for `config check`. */
    readonly path: string;
    /** Lowercase hex SHA-256 of `bytes`. */
    readonly sha256: string;
  }
  | {
    readonly kind: "url";
    /** An `https:` URL without credentials. */
    readonly url: string;
  };

/** The installation's logo in Review's viewer bar. */
export interface ViewerLogo {
  /** Alternative text, 1 to 100 characters. */
  readonly alt: string;
  /** An `https:` URL or a root-relative path the logo links to, or null. */
  readonly link: string | null;
  readonly source: ViewerLogoSource;
}
