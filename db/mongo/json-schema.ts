// $jsonSchema pieces shared by the collection validators (docs/HANDOFF.md 4.4).
//
// Whole numbers are bsonType "number" + multipleOf 1, never "int": mongosh and
// Compass store 1 as a double, and "int" rejects it (HANDOFF section 8).

/** A MySQL id: a whole number, 1 or more. */
export const ID = { bsonType: "number", multipleOf: 1, minimum: 1 } as const;

/** A MySQL id or null. */
export const NULLABLE_ID = { bsonType: ["number", "null"], multipleOf: 1, minimum: 1 } as const;

/** A count: a whole number, 0 or more. */
export const COUNT = { bsonType: "number", multipleOf: 1, minimum: 0 } as const;
