type ApiSuccess<T> = {
  ok: true;
  data: T;
};

type ApiFailure = {
  ok: false;
  error: string;
};

type ApiResult<T> = ApiSuccess<T> | ApiFailure;

type Product = {
  sku: string;
  price: number;
  metadata?: Record<string, string>;
};

const productResult: ApiResult<Product> = {
  ok: true,
  data: {
    sku: "sku-1",
    price: 12.5,
    metadata: { color: "blue" }
  }
};

function unwrap<T>(result: ApiResult<T>, fallback: T): T {
  return result.ok ? result.data : fallback;
}

const fallbackProduct: Product = { sku: "fallback", price: 0 };
const product = unwrap(productResult, fallbackProduct);
const productSku = product.sku;
const productColor = product.metadata?.color;

function pluck<T, K extends keyof T>(value: T, key: K): T[K] {
  return value[key];
}

const pluckedPrice = pluck(product, "price");
const pluckedMetadata = pluck(product, "metadata");

class Repository<T extends { sku: string }> {
  readonly items = new Map<string, T>();

  add(item: T) {
    this.items.set(item.sku, item);
    return this;
  }

  get(sku: string) {
    return this.items.get(sku);
  }
}

const productRepository = new Repository<Product>();
const repositoryAfterAdd = productRepository.add(product);
const repositoryProduct = repositoryAfterAdd.get("sku-1");

void [productSku, productColor, pluckedPrice, pluckedMetadata, repositoryProduct];

export { product, productSku, productColor, pluckedPrice, repositoryProduct };
