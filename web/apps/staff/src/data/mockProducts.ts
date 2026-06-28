import type { ProductRecord } from "../domain/types";

export const mockProducts: ProductRecord[] = [
  {
    id: "product-1001",
    code: "1000GY",
    name: "FUELFLEX GREEN",
    category: "Composite",
    subCategory: "Petrol & Oil",
    standardCode: "AS2683"
  },
  {
    id: "product-1002",
    code: "SS1",
    name: "SS1 CONV",
    category: "Stainless Steel",
    subCategory: "Convoluted",
    standardCode: "AS2683"
  },
  {
    id: "product-1003",
    code: "RUB-WATER",
    name: "Rubber Water Hose",
    category: "Rubber",
    subCategory: "Water",
    standardCode: "ISO10380"
  }
];
