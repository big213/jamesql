import { getParams, objectTypeDefs, inputTypeDefs, lookupSymbol } from "..";
import {
  JomqlArgsError,
  JomqlInputType,
  JomqlQueryError,
  JomqlResultError,
  JomqlObjectType,
  JomqlScalarType,
  JomqlInputTypeLookup,
  JomqlObjectTypeLookup,
  JomqlInputFieldType,
} from "../classes";

import {
  JomqlResolverNode,
  ResolverObject,
  RootResolverDefinition,
  JomqlProcessorFunction,
  ObjectTypeDefinitionField,
  isRootResolverDefinition,
  ArrayOptions,
  StringKeyObject,
} from "../types";

export function isObject(ele: unknown): ele is StringKeyObject {
  return Object.prototype.toString.call(ele) === "[object Object]";
}

// validates and replaces the args, returns the validated args
export function validateExternalArgs(
  args: unknown,
  argDefinition: JomqlInputFieldType | undefined,
  fieldPath: string[]
): unknown {
  let parsedArgs;

  // if no argDefinition and args provided, throw error
  if (!argDefinition) {
    if (args)
      throw new JomqlArgsError({
        message: `Not expecting any args`,
        fieldPath,
      });
    else return;
  }

  // if no arg required and args is undefined, return
  if (!argDefinition.definition.required && args === undefined) return;

  // if argDefinition.required and args is undefined, throw err
  if (argDefinition.definition.required && args === undefined)
    throw new JomqlArgsError({
      message: `Args is required`,
      fieldPath,
    });

  // if !argDefinition.allowNull and args is null, throw err
  if (!argDefinition.definition.allowNull && args === null)
    throw new JomqlArgsError({
      message: `Null field is not allowed`,
      fieldPath,
    });

  // if array field
  if (argDefinition.definition.arrayOptions) {
    // if allowNull and not array, must be null
    if (
      argDefinition.definition.allowNull &&
      !Array.isArray(args) &&
      args !== null
    ) {
      throw new JomqlArgsError({
        message: `Field must be Array or null`,
        fieldPath,
      });
    }

    // if !allowNull and not array, throw err
    if (!argDefinition.definition.allowNull && !Array.isArray(args))
      throw new JomqlArgsError({
        message: `Array expected`,
        fieldPath,
      });
  }

  let argDefType = argDefinition.definition.type;

  // // if lookup field, convert from map
  if (argDefType instanceof JomqlInputTypeLookup) {
    const inputDef = inputTypeDefs.get(argDefType.name);
    if (!inputDef)
      throw new JomqlArgsError({
        message: `Unknown inputDef '${argDefType}'`,
        fieldPath,
      });
    argDefType = inputDef;
  }

  // if argDefinition.type is inputTypeDefinition
  if (argDefType instanceof JomqlInputType) {
    let argsArray: unknown[];
    const fields = argDefType.definition.fields;
    // if args is array and it is supposed to be array, process each array element
    if (Array.isArray(args) && argDefinition.definition.arrayOptions) {
      // if !allowNullElements and there is a null element, throw err
      if (
        !argDefinition.definition.arrayOptions.allowNullElement &&
        args.some((ele) => ele === null)
      ) {
        throw new JomqlArgsError({
          message: `Null field is not allowed on array element`,
          fieldPath,
        });
      }
      argsArray = args;
    } else {
      argsArray = [args];
    }

    // process all args
    for (const arg of argsArray) {
      if (!isObject(arg) && !argDefinition.definition.allowNull)
        throw new JomqlArgsError({
          message: `Object expected`,
          fieldPath,
        });

      // if arg is null and allowed to be null, do nothing
      if (isObject(arg)) {
        const keysToValidate = new Set(Object.keys(arg));
        Object.entries(fields).forEach(([key, argDef]) => {
          // validate each key of arg
          const validatedArg = validateExternalArgs(
            arg[key],
            argDef,
            fieldPath.concat(key)
          );
          // if key is undefined, make sure it is deleted
          if (validatedArg === undefined) delete arg[key];
          else {
            arg[key] = validatedArg;
          }
          keysToValidate.delete(key);
        });

        // check if any remaining keys to validate (aka unknown args)
        if (keysToValidate.size > 0) {
          throw new JomqlArgsError({
            message: `Unknown args '${[...keysToValidate].join(",")}'`,
            fieldPath,
          });
        }

        // perform validation on results
        if (argDefType.definition.inputsValidator) {
          argDefType.definition.inputsValidator(arg, fieldPath);
        }
      }
    }
  } else {
    // if argDefinition.type is scalarDefinition, attempt to parseValue args
    // replace value if parseValue
    const parseValue = argDefType.definition.parseValue;

    // if arg is null, skip
    if (parseValue && args !== null) {
      try {
        // if arg is an array and supposed to be array, loop through
        if (Array.isArray(args) && argDefinition.definition.arrayOptions) {
          parsedArgs = args.map((ele: unknown) => parseValue(ele));
        } else {
          parsedArgs = parseValue(args);
        }
      } catch {
        // transform any errors thrown into JomqlParseError
        throw new JomqlArgsError({
          message: `Invalid scalar value for '${argDefType.definition.name}'`,
          fieldPath: fieldPath,
        });
      }
    }
  }

  /*
  // if an argsValidator function is available, also run that
  if (argDefinition.argsValidator) {
    argDefinition.argsValidator(parsedArgs, fieldPath);
  }
  */
  return parsedArgs ?? args;
}

// traverses results according to JomqlResolverTree and validates nulls, arrays, extracts results from objs
export async function validateJomqlResults(
  jomqlResultsNode: unknown,
  jomqlResolverNode: JomqlResolverNode,
  fieldPath: string[]
): Promise<unknown> {
  const nested = jomqlResolverNode.nested;

  if (nested) {
    // if output is null, cut the tree short and return
    if (jomqlResultsNode === null) return null;
    if (jomqlResolverNode.typeDef.arrayOptions) {
      if (Array.isArray(jomqlResultsNode)) {
        return Promise.all(
          jomqlResultsNode.map(async (ele) => {
            const arrReturnValue: StringKeyObject = {};
            for (const field in jomqlResolverNode.nested) {
              arrReturnValue[field] = await validateJomqlResults(
                ele[field],
                jomqlResolverNode.nested[field],
                fieldPath.concat(field)
              );
            }
            return arrReturnValue;
          })
        );
      } else {
        // if field is not Array or null, throw err
        throw new JomqlResultError({
          message: `Expecting array or null`,
          fieldPath: fieldPath,
        });
      }
    } else {
      const tempReturnValue: StringKeyObject = {};
      // if no nested fields requested, return empty object
      if (
        jomqlResolverNode.nested &&
        Object.keys(jomqlResolverNode.nested).length < 1
      ) {
        return isObject(jomqlResultsNode) ? tempReturnValue : null;
      }

      if (!isObject(jomqlResultsNode))
        throw new JomqlResultError({
          message: `Expecting object`,
          fieldPath: fieldPath,
        });

      for (const field in jomqlResolverNode.nested) {
        tempReturnValue[field] = await validateJomqlResults(
          jomqlResultsNode[field],
          jomqlResolverNode.nested[field],
          fieldPath.concat(field)
        );
      }
      return tempReturnValue;
    }
  } else {
    // check for nulls and ensure array fields are arrays
    validateResultFields(
      jomqlResultsNode,
      jomqlResolverNode.typeDef,
      fieldPath
    );

    // if typeDef of field is ScalarDefinition, apply the serialize function to the end result
    let fieldType = jomqlResolverNode.typeDef.type;

    if (fieldType instanceof JomqlObjectTypeLookup) {
      const typeDef = objectTypeDefs.get(fieldType.name);
      if (!typeDef) {
        throw new JomqlQueryError({
          message: `TypeDef '${fieldType.name}' not found`,
          fieldPath: fieldPath,
        });
      }
      fieldType = typeDef;
    }

    if (fieldType instanceof JomqlObjectType) {
      return jomqlResultsNode;
    } else {
      const serializeFn = fieldType.definition.serialize;
      // if field is null, skip
      if (
        serializeFn &&
        jomqlResultsNode !== null &&
        jomqlResultsNode !== undefined
      ) {
        try {
          if (
            Array.isArray(jomqlResultsNode) &&
            jomqlResolverNode.typeDef.arrayOptions
          ) {
            return jomqlResultsNode.map((ele: unknown) => serializeFn(ele));
          } else {
            return serializeFn(jomqlResultsNode);
          }
        } catch {
          // transform any errors thrown into JomqlParseError
          throw new JomqlResultError({
            message: `Invalid scalar value for '${fieldType.definition.name}'`,
            fieldPath: fieldPath,
          });
        }
      } else {
        return jomqlResultsNode;
      }
    }
  }
}

// throws an error if a field is not an array when it should be
export function validateResultFields(
  value: unknown,
  resolverObject: ResolverObject,
  fieldPath: string[]
): void {
  if (resolverObject.arrayOptions) {
    if (Array.isArray(value)) {
      value.forEach((ele) => {
        validateResultNullish(
          ele,
          resolverObject,
          fieldPath,
          resolverObject.arrayOptions
        );
      });
    } else if (!resolverObject.allowNull) {
      throw new JomqlResultError({
        message: `Array expected`,
        fieldPath,
      });
    } else if (value !== null) {
      // field must be null
      throw new JomqlResultError({
        message: `Array or null expected`,
        fieldPath,
      });
    }
  } else {
    validateResultNullish(
      value,
      resolverObject,
      fieldPath,
      resolverObject.arrayOptions
    );
  }
}

// throws an error if a field is nullish when it should not be
export function validateResultNullish(
  value: unknown,
  resolverObject: ResolverObject,
  fieldPath: string[],
  arrayOptions: ArrayOptions | undefined
): void {
  const isNullAllowed = arrayOptions
    ? arrayOptions.allowNullElement
    : resolverObject.allowNull;
  if ((value === null || value === undefined) && !isNullAllowed) {
    throw new JomqlResultError({
      message:
        `Null value not allowed` + (arrayOptions ? " for array element" : ""),
      fieldPath,
    });
  }
}

// starts generateJomqlResolverTree from a TypeDef
export function generateAnonymousRootResolver(
  type: JomqlObjectType | JomqlObjectTypeLookup | JomqlScalarType
): ObjectTypeDefinitionField {
  const anonymousRootResolver: ObjectTypeDefinitionField = {
    allowNull: true,
    type,
  };

  return anonymousRootResolver;
}

export function generateJomqlResolverTree(
  fieldValue: unknown,
  resolverObject: ObjectTypeDefinitionField | RootResolverDefinition,
  fieldPath: string[] = [],
  fullTree = false
): JomqlResolverNode {
  let fieldType = resolverObject.type;

  // if string, attempt to convert to TypeDefinition
  if (fieldType instanceof JomqlObjectTypeLookup) {
    const typeDefLookup = objectTypeDefs.get(fieldType.name);
    if (!typeDefLookup) {
      throw new JomqlQueryError({
        message: `TypeDef '${fieldType.name}' not found`,
        fieldPath: fieldPath,
      });
    }
    fieldType = typeDefLookup;
  }

  // define the lookupValue
  const lookupValue = getParams().lookupValue;

  // field must either be lookupValue OR an object
  // check if field is lookupValue
  const isLookupField =
    fieldValue === lookupValue || fieldValue === lookupSymbol;

  const isLeafNode = !(fieldType instanceof JomqlObjectType);

  // field must either be lookupValue OR an object
  if (!isLookupField && !isObject(fieldValue))
    throw new JomqlQueryError({
      message: `Invalid field RHS`,
      fieldPath: fieldPath,
    });

  // if leafNode and nested, MUST be only with __args
  if (isLeafNode && isObject(fieldValue)) {
    if (!("__args" in fieldValue) || Object.keys(fieldValue).length !== 1) {
      throw new JomqlQueryError({
        message: `Scalar node can only accept __args and no other field`,
        fieldPath,
      });
    }
  }

  // if not leafNode and isLookupField, deny
  if (!isLeafNode && isLookupField)
    throw new JomqlQueryError({
      message: `Resolved node must be an object with nested fields`,
      fieldPath,
    });

  // if field is scalar and args is required, and not object, throw err
  if (
    isLeafNode &&
    resolverObject.args?.definition.required &&
    !isObject(fieldValue)
  ) {
    throw new JomqlQueryError({
      message: `Args required`,
      fieldPath,
    });
  }

  let nestedNodes: { [x: string]: JomqlResolverNode } | null = null;

  // separate args from query
  const { __args: args = null, ...query } = isObject(fieldValue)
    ? fieldValue
    : {};

  if (isObject(fieldValue)) {
    // validate args, if any
    validateExternalArgs(
      fieldValue.__args,
      resolverObject.args,
      fieldPath.concat("__args")
    );

    if (!isLeafNode && fieldType instanceof JomqlObjectType) {
      nestedNodes = {};

      // iterate over fields
      for (const field in fieldValue) {
        const parentsPlusCurrentField = fieldPath.concat(field);
        if (field === "__args") {
          continue;
        }

        // if field not in TypeDef, reject
        if (!(field in fieldType.definition.fields)) {
          throw new JomqlQueryError({
            message: `Unknown field`,
            fieldPath: parentsPlusCurrentField,
          });
        }

        // deny hidden fields
        if (fieldType.definition.fields[field].hidden) {
          throw new JomqlQueryError({
            message: `Hidden field`,
            fieldPath: parentsPlusCurrentField,
          });
        }

        // only if no resolver do we recursively add to tree
        // if there is a resolver, the sub-tree should be generated in the resolver
        if (fullTree || !resolverObject.resolver)
          nestedNodes[field] = generateJomqlResolverTree(
            fieldValue[field],
            fieldType.definition.fields[field],
            parentsPlusCurrentField,
            fullTree
          );
      }
    }
  }
  return {
    typeDef: resolverObject,
    query,
    args,
    nested: nestedNodes ?? undefined,
  };
}

// resolves the queries, and attaches them to the obj (if possible)
export const processJomqlResolverTree: JomqlProcessorFunction = async ({
  jomqlResultsNode,
  jomqlResolverNode,
  parentNode,
  req,
  data = {},
  fieldPath = [],
  fullTree = false,
}) => {
  let results;
  // if it is a root resolver, fetch the results first.
  if (isRootResolverDefinition(jomqlResolverNode.typeDef)) {
    results = await jomqlResolverNode.typeDef.resolver({
      req,
      fieldPath,
      args: jomqlResolverNode.args,
      query: jomqlResolverNode.query,
    });
    // if full tree not required, return here
    if (!fullTree) return results;
  } else {
    results = jomqlResultsNode;
  }

  const resolverFn = jomqlResolverNode.typeDef.resolver;
  const nested = jomqlResolverNode.nested;

  // if typeDef is RootResolverDefinition, skip resolving (should already be done)
  if (resolverFn && !isRootResolverDefinition(jomqlResolverNode.typeDef)) {
    // if defer, skip resolving
    if (jomqlResolverNode.typeDef.defer) {
      return null;
    }
    return resolverFn({
      req,
      fieldPath,
      args: jomqlResolverNode.args,
      query: jomqlResolverNode.query,
      fieldValue: results,
      parentValue: parentNode,
      data,
    });
  } else if (nested && isObject(results)) {
    // must be nested field.
    const tempReturnValue = results;

    for (const field in jomqlResolverNode.nested) {
      const currentFieldPath = fieldPath.concat(field);
      tempReturnValue[field] = await processJomqlResolverTree({
        jomqlResultsNode: isObject(results) ? results[field] : null,
        parentNode: results,
        jomqlResolverNode: jomqlResolverNode.nested[field],
        req,
        data,
        fieldPath: currentFieldPath,
      });
    }
    return tempReturnValue;
  } else {
    return results;
  }
};
