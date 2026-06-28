import { ModuleTable, type ModuleColumn } from "./ModuleTable";
import { useProductsWorkspace } from "../hooks/useProductsWorkspace";
import type { ProductRecord } from "../domain/types";

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
  }
];

export function ProductsWorkspace() {
  const workspace = useProductsWorkspace();

  return (
    <ModuleTable
      actionLabel="Add Product"
      columns={productColumns}
      countLabel={`${workspace.products.length} products`}
      emptyLabel="No products match the current filters."
      getRowKey={(product) => product.id}
      items={workspace.visibleProducts}
      onQueryChange={workspace.setQuery}
      query={workspace.query}
      searchLabel="Search products"
      searchPlaceholder="Search products..."
      source={workspace.source}
      tableLabel="Product records"
    />
  );
}
