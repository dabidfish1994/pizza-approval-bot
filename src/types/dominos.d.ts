/**
 * Hand-written types for `dominos@3`, which ships no declarations.
 *
 * Only the surface this project uses is declared. Note the v3 menu payload uses
 * lowercase keys (`productType`, `variants`) while the published docs still show
 * PascalCase — these follow the runtime, which was verified against a live store.
 */
declare module 'dominos' {
  export class NearbyStores {
    constructor(address: string, type?: string);
    stores: Array<{
      StoreID: string | number;
      IsOnlineCapable?: boolean;
      IsDeliveryStore?: boolean;
      IsOpen?: boolean;
      ServiceIsOpen?: { Delivery?: boolean; Carryout?: boolean };
      AddressDescription?: string;
      ServiceMethodEstimatedWaitMinutes?: { Delivery?: { Min?: number } };
      [key: string]: unknown;
    }>;
  }

  export class Menu {
    constructor(storeID: string | number, lang?: string);
    menu: {
      variants?: Record<string, { code: string; name: string; price: string | number; productCode?: string }>;
      products?: Record<string, { code: string; name: string; productType?: string }>;
      [key: string]: unknown;
    };
  }

  export class Customer {
    constructor(params: {
      address: string;
      firstName?: string;
      lastName?: string;
      phone?: string;
      email?: string;
    });
  }

  export class Item {
    constructor(params: { code: string; qty?: number; options?: Record<string, unknown> });
  }

  export class Payment {
    constructor(params: {
      amount?: number;
      tipAmount?: number;
      number: string;
      expiration: string;
      securityCode: string;
      postalCode: string;
    });
    /** Empty when the library failed to recognize the card — check this. */
    cardType: string;
    number: string;
    amount: number;
    tipAmount: number;
  }

  export class Order {
    constructor(customer: Customer);
    storeID: string | number;
    serviceMethod: 'Delivery' | 'Carryout';
    products: Array<Record<string, unknown>>;
    payments: Payment[];
    address: { region?: string; [key: string]: unknown };
    amountsBreakdown: Record<string, string | number>;
    validationResponse?: { Status?: number; [key: string]: unknown };
    priceResponse?: { Status?: number; [key: string]: unknown };
    placeResponse?: { Status?: number; Order?: { OrderID?: string }; [key: string]: unknown };
    orderID?: string;
    addItem(item: Item): Order;
    validate(): Promise<Order>;
    price(): Promise<Order>;
    place(): Promise<Order>;
  }

  export class Tracking {
    byPhone(phone: string): Promise<unknown>;
  }

  export class Address {
    constructor(address: string | Record<string, unknown>);
  }
}
