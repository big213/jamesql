import type { Express } from "express";
import {
  createJomqlRequestHandler,
  createRestRequestHandler,
} from "./helpers/router";
import type { Params, Schema, RootResolverObject } from "./types";
export {
  RootResolverMap,
  RootResolverObject,
  Schema,
  ResolverFunction,
  TypeDefinitionField,
  TypeDefinition,
  ArgDefinition,
  InputTypeDefinition,
  ScalarDefinition,
  JomqlResolverNode,
  isScalarDefinition,
  isInputTypeDefinition,
  JsType,
} from "./types";
export { JomqlFieldError } from "./classes";
export { TsSchemaGenerator } from "./classes/schema";

let exportedSchema: Schema, exportedLookupValue: any, exportedDebug: boolean;

export function initializeJomql(app: Express, params: Params) {
  const { schema, debug, lookupValue = null, jomqlPath = "/jomql" } = params;

  // jomqlPath must start with '/'
  if (!jomqlPath.match(/^\//)) {
    throw new Error("Invalid jomqlPath");
  }

  exportedSchema = schema;

  //lookup value must be primitive. i.e. null, true, false, 1
  exportedLookupValue = lookupValue;

  exportedDebug = !!debug;

  app.post(jomqlPath, createJomqlRequestHandler(schema.rootResolvers));

  // populate all RESTful routes. This should only be done on cold starts.
  schema.rootResolvers.forEach((item, key) => {
    if (item.route === jomqlPath)
      throw new Error(`Duplicate route for jomql path: '${jomqlPath}'`);

    app[item.method](item.route, createRestRequestHandler(item, key));
  });

  app.set("json replacer", function (key: string, value: any) {
    // undefined values are set to `null`
    if (typeof value === "undefined") {
      return null;
    }
    return value;
  });
}

export const getSchema = () => exportedSchema;

export const getLookupValue = () => exportedLookupValue;

export const getTypeDefs = () => exportedSchema.typeDefs;

export const getInputDefs = () => exportedSchema.inputDefs;

export const isDebug = () => exportedDebug;

export * as BaseScalars from "./scalars";

export {
  generateJomqlResolverTree,
  processJomqlResolverTree,
  handleAggregatedQueries,
  validateExternalArgs,
  validateResultFields,
} from "./helpers/jomql";

export { ErrorWrapper } from "./classes/errorWrapper";
