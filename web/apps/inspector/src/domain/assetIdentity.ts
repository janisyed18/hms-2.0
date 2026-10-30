/** What an asset is called on screen: its name, or its number when it has no usable name. Never blank. */
export function assetDisplayName(asset: { assetNumber: string; assetName?: string | null }): string {
  return asset.assetName?.trim() || asset.assetNumber.trim();
}

/** The asset number as a secondary line, or null when the name is just the number again. */
export function assetSecondaryNumber(asset: { assetNumber: string; assetName?: string | null }): string | null {
  const name = asset.assetName?.trim();
  return name && name !== asset.assetNumber.trim() ? asset.assetNumber : null;
}
