/**
 * The one table of what the per-artifact asset store accepts and how it serves
 * it. Upload plans, commits, copies, and `/_blob/<id>` all read these values,
 * so a type, a cap, or a disposition changes in one place.
 */

import {AssetLimitExceeded, AssetTypeUnsupported} from "./errors.js";
import type {AssetUsage} from "./model.js";

const mebibyte = 1_048_576;

/** How one accepted media type is capped and served. */
export interface AssetMediaType {
  /** The exact `Content-Type` sent by `/_blob/<id>`. */
  readonly contentType: string;
  /** Whether a top-level navigation renders it; otherwise it downloads. */
  readonly inline: boolean;
  readonly maximumBytes: number;
}

const media = (contentType: string): AssetMediaType => ({
  contentType,
  inline: true,
  maximumBytes: 20 * mebibyte,
});
const text = (essence: string, maximumBytes: number): AssetMediaType => ({
  contentType: `${essence}; charset=utf-8`,
  inline: true,
  maximumBytes,
});
const download = (contentType: string): AssetMediaType => ({
  contentType,
  inline: false,
  maximumBytes: 20 * mebibyte,
});

/**
 * Every media type the asset store accepts, keyed by its lowercase essence.
 * HTML and XML are absent on purpose: an uploaded file never becomes a page.
 * SVG is an image with a smaller cap, and its response carries a policy that
 * runs no script. PDF downloads because a sandboxed document cannot host a
 * PDF viewer.
 */
export const assetMediaTypes: ReadonlyMap<string, AssetMediaType> = new Map([
  ["image/png", media("image/png")],
  ["image/jpeg", media("image/jpeg")],
  ["image/gif", media("image/gif")],
  ["image/webp", media("image/webp")],
  ["image/avif", media("image/avif")],
  ["image/svg+xml", {...media("image/svg+xml"), maximumBytes: 2 * mebibyte}],
  ["video/mp4", media("video/mp4")],
  ["video/webm", media("video/webm")],
  ["application/pdf", download("application/pdf")],
  ["font/woff", download("font/woff")],
  ["font/woff2", download("font/woff2")],
  ["text/css", text("text/css", 16 * mebibyte)],
  ["text/javascript", text("text/javascript", 16 * mebibyte)],
  ["text/csv", text("text/csv", 20 * mebibyte)],
  ["application/json", text("application/json", 20 * mebibyte)],
  ["text/markdown", text("text/markdown", 20 * mebibyte)],
  ["text/plain", text("text/plain", 20 * mebibyte)],
]);

/** How many assets, and how many bytes in all, one artifact may hold. */
export interface AssetQuota {
  readonly maximumAssets: number;
  readonly maximumBytes: number;
}

export const defaultAssetQuota: AssetQuota = {
  maximumAssets: 500,
  maximumBytes: 512 * mebibyte,
};

/** A media type the store accepts, with its policy. */
export interface AcceptedAssetMediaType {
  readonly mediaType: string;
  readonly policy: AssetMediaType;
}

/** The stored media type for a declared one, or a refusal naming what is accepted. */
export function acceptedAssetMediaType(
  declared: string,
): AcceptedAssetMediaType | AssetTypeUnsupported {
  const mediaType = declared.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const policy = assetMediaTypes.get(mediaType);
  if (policy === undefined) {
    return new AssetTypeUnsupported({
      message: `The media type "${mediaType}" is not accepted. Accepted types: ${[...assetMediaTypes.keys()].join(", ")}.`,
    });
  }
  return {mediaType, policy};
}

/**
 * Check one more asset of `size` bytes against its type cap and the artifact
 * quota before any byte is stored. The repository repeats the quota part
 * under the lock that writes the row.
 */
export function assetLimitFailure(
  {mediaType, policy}: AcceptedAssetMediaType,
  size: number,
  usage: AssetUsage,
  quota: AssetQuota,
): AssetLimitExceeded | null {
  if (size > policy.maximumBytes) {
    return new AssetLimitExceeded({
      message: `A ${mediaType} asset is at most ${policy.maximumBytes} bytes, and this one is ${size}.`,
    });
  }
  return assetQuotaFailure(size, usage, quota);
}

/** Check one more asset of `size` bytes against the artifact quota alone. */
export function assetQuotaFailure(
  size: number,
  usage: AssetUsage,
  quota: AssetQuota,
): AssetLimitExceeded | null {
  if (usage.assetCount + 1 > quota.maximumAssets) {
    return new AssetLimitExceeded({
      message: `The artifact already holds its limit of ${quota.maximumAssets} assets.`,
    });
  }
  if (usage.byteCount + size > quota.maximumBytes) {
    return new AssetLimitExceeded({
      message: `The artifact's assets would use ${usage.byteCount + size} bytes, over its limit of ${quota.maximumBytes}.`,
    });
  }
  return null;
}
