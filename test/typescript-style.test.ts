import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { parseJson } from "../src/shared/validation.ts";

// Strict TypeScript alone still permits assertions and inferred values from untyped APIs.
test("TypeScript has no casts, explicit any, or inferred any declarations", () => {
  const config = ts.parseJsonConfigFileContent(parseJson(readFileSync("tsconfig.json", "utf8")), ts.sys, ".");
  const program = ts.createProgram(config.fileNames, config.options);
  const checker = program.getTypeChecker();
  const failures: string[] = [];

  const isArray = (type: ts.Type): type is ts.TypeReference =>
    checker.isArrayType(type) || checker.isTupleType(type);
  const includesAny = (type: ts.Type): boolean => {
    if (type.flags & ts.TypeFlags.Any) return true;
    if (type.isUnionOrIntersection()) return type.types.some(includesAny);
    if (isArray(type)) {
      return checker.getTypeArguments(type).some(includesAny);
    }
    const awaited = checker.getAwaitedType(type);
    return awaited !== undefined && awaited !== type && includesAny(awaited);
  };

  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || source.fileName.includes("node_modules/")) continue;
    const report = (node: ts.Node, message: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${source.fileName}:${line + 1}: ${message}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
        report(node, "Use narrowing, not a cast");
      if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "Use unknown, not any");
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        includesAny(checker.getTypeAtLocation(node.name))
      ) {
        report(node, "Validate untyped values before using them");
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(failures, []);
});
