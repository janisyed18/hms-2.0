import { assetDisplayName, assetHasDistinctName } from "../utils/identity";

/**
 * An asset as people recognise it: the name first, the asset number underneath as the disambiguator
 * (two assets can share a name). With no usable name the number is the primary text and appears once.
 */
export function AssetIdentity({ asset }: { asset: { assetNumber: string; assetName?: string | null } }) {
  const name = assetDisplayName(asset);
  return (
    <span className="asset-identity">
      <strong className="asset-identity-name" title={name}>{name}</strong>
      {assetHasDistinctName(asset) ? <small className="asset-identity-number">Asset #{asset.assetNumber}</small> : null}
    </span>
  );
}
