import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { ProductForm } from "./ProductForm";
import { useProductsWorkspace } from "../hooks/useProductsWorkspace";
import type { ProductRecord } from "../domain/types";

export function ProductsWorkspace() {
  const workspace = useProductsWorkspace();
  const productColumns: ModuleColumn<ProductRecord>[] = [
    {
      header: "Code",
      render: (product) => <strong>{product.code}</strong>
    },
    {
      header: "Product Name",
      render: (product) => product.name
    },
    {
      header: "Category",
      render: (product) => product.category
    },
    {
      header: "Sub Category",
      render: (product) => product.subCategory ?? "Not set"
    },
    {
      header: "Standard",
      render: (product) => product.standardCode ?? "No standard"
    },
    {
      header: "Actions",
      render: (product) => (
        <span className="row-actions">
          <button type="button" onClick={() => workspace.openEdit(product)}>
            Edit
          </button>
          <button
            type="button"
            aria-label={`Archive ${product.name}`}
            onClick={() => workspace.archiveProduct(product)}
          >
            Archive
          </button>
        </span>
      )
    }
  ];

  return (
    <>
      <ModuleTable
        actionLabel="Add Product"
        columns={productColumns}
        countLabel={`${workspace.products.length} products`}
        emptyLabel="No products match the current filters."
        exportRows={(product) => [
          product.code,
          product.name,
          product.category,
          product.subCategory ?? "",
          product.standardCode ?? "",
          ""
        ]}
        getRowKey={(product) => product.id}
        items={workspace.visibleProducts}
        onAction={workspace.openCreate}
        onQueryChange={workspace.setQuery}
        query={workspace.query}
        searchLabel="Search products"
        searchPlaceholder="Search products..."
        source={workspace.source}
        tableLabel="Product records"
      />
      <ProductForm
        open={workspace.isFormOpen}
        product={workspace.editingProduct}
        onClose={() => workspace.setFormOpen(false)}
        onSubmit={workspace.saveProduct}
      />
    </>
  );
}
