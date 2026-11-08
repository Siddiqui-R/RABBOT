import type { InferSchema, ReducerCtx } from "spacetimedb/server";
import type spacetimedb from "./schema";

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
