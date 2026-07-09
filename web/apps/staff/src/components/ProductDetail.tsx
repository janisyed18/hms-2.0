import { Boxes, Tag, X } from "lucide-react";

import type { ProductRecord } from "../domain/types";

interface ProductDetailProps {
  product: ProductRecord;
  onClose: () => void;
}

export function ProductDetail({ product, onClose }: ProductDetailProps) {
  return (
    <aside className="inspection-detail-panel" aria-label="Product detail">
      <div className="inspection-detail-header">
        <div>
          <h2>{product.name}</h2>
          <p>{product.code} / {product.category}</p>
        </div>
        <button
          aria-label="Close product detail"
          className="icon-button light"
          onClick={onClose}
          type="button"
        >
          <X size={18} />
        </button>
      </div>

      <div className="inspection-detail-strip">
        <span className="mini-status current">{product.category}</span>
        <span>{product.subCategory ?? "No sub category"}</span>
        <span>{product.standardCode ?? "No standard"}</span>
      </div>

      <div className="inspection-facts">
        <div>
          <span>Product code</span>
          <strong>{product.code}</strong>
        </div>
        <div>
          <span>Name</span>
          <strong>{product.name}</strong>
        </div>
        <div>
          <span>Category</span>
          <strong>{product.category}</strong>
        </div>
        <div>
          <span>Standard</span>
          <strong>{product.standardCode ?? "Not linked"}</strong>
        </div>
      </div>

      <div className="certificate-verification">
        <div>
          <Boxes aria-hidden="true" size={18} />
          <span>Catalog record</span>
          <strong>{product.id}</strong>
        </div>
        <div>
          <Tag aria-hidden="true" size={18} />
          <span>Sub category</span>
          <strong>{product.subCategory ?? "Not set"}</strong>
        </div>
      </div>
    </aside>
  );
}
