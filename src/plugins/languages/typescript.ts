import ts from 'typescript';
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';

const getLineRange = (sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } => {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getFullStart()).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine, endLine };
};

/**
 * Defensive helper that correctly detects whether a node has an implementation.
 * Returns true only when node.body exists, the source file is not a declaration file,
 * and the node does not have an abstract modifier.
 */
const hasImplementation = (node: ts.Node): boolean => {
  const anyNode = node as any;
  if (!anyNode.body) {
    return false;
  }

  if (node.getSourceFile().isDeclarationFile === true) {
    return false;
  }

  if (anyNode.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.AbstractKeyword)) {
    return false;
  }

  return true;
};

class TypeScriptParser {
  async parse(file: FileToChunk): Promise<ParsedSourceFile> {
    const sourceFile = ts.createSourceFile(file.filePath, file.content, ts.ScriptTarget.Latest, true);
    const declarations: ParsedDeclaration[] = [];
    const importNodes: ts.ImportDeclaration[] = [];

    const visit = (node: ts.Node) => {
      let type: SymbolKind | undefined;
      let name: string | undefined;

      if (ts.isImportDeclaration(node)) {
        importNodes.push(node);
      } else if (ts.isInterfaceDeclaration(node)) {
        type = 'interface';
        name = node.name.text;
      } else if (ts.isFunctionDeclaration(node) && hasImplementation(node)) {
        type = 'function';
        name = node.name ? node.name.text : '<anonymous>';
      } else if (ts.isClassDeclaration(node)) {
        type = 'class';
        name = node.name ? node.name.text : '<anonymous>';
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = node.name.text;
      } else if (ts.isConstructorDeclaration(node) && hasImplementation(node)) {
        type = 'constructor';
        name = 'constructor';
      } else if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = `get ${node.name.text}`;
      } else if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name) && hasImplementation(node)) {
        type = 'method';
        name = `set ${node.name.text}`;
      } else if (ts.isEnumDeclaration(node)) {
        type = 'enum';
        name = node.name.text;
      } else if (ts.isTypeAliasDeclaration(node)) {
        type = 'typeAlias';
        name = node.name.text;
      } else if (ts.isModuleDeclaration(node)) {
        type = 'namespace';
        name = node.name.text;
      } else if (ts.isExportAssignment(node)) {
        // Handle export default expressions
        const expression = node.expression;
        if (ts.isFunctionExpression(expression)) {
          type = 'function';
          name = expression.name ? expression.name.text : '<anonymous>';
        } else if (ts.isArrowFunction(expression)) {
          type = 'function';
          name = '<anonymous>';
        } else if (ts.isClassExpression(expression)) {
          type = 'class';
          name = expression.name ? expression.name.text : '<anonymous>';
        } else if (ts.isIdentifier(expression)) {
          type = 'unknown';
          name = expression.text;
        } else {
          type = 'unknown';
          name = '<anonymous>';
        }
      } else if (ts.isVariableStatement(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          const { startLine, endLine } = getLineRange(sourceFile, node);
          const content = sourceFile.getFullText().slice(node.getFullStart(), node.getEnd()).trim();

          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              const varName = declaration.name.text;
              let varType: SymbolKind = 'variable';
              if (declaration.initializer) {
                if (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer)) {
                  varType = 'function';
                } else if (ts.isCallExpression(declaration.initializer)) {
                  const hasFunctionArg = declaration.initializer.arguments.some(
                    (arg) => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
                  );
                  if (hasFunctionArg) {
                    varType = 'function';
                  }
                }
              }

              declarations.push({
                type: varType,
                name: varName,
                startLine,
                endLine,
                content,
              });
            }
          }
        }
      }

      if (type && name) {
        const { startLine, endLine } = getLineRange(sourceFile, node);
        declarations.push({
          type,
          name,
          startLine,
          endLine,
          content: sourceFile.getFullText().slice(node.getFullStart(), node.getEnd()).trim(),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (importNodes.length > 0) {
      const firstImport = importNodes[0];
      const lastImport = importNodes[importNodes.length - 1];

      if (firstImport && lastImport) {
        const { startLine } = getLineRange(sourceFile, firstImport);
        const { endLine } = getLineRange(sourceFile, lastImport);

        declarations.push({
          type: 'import',
          name: 'imports',
          startLine,
          endLine,
          content: importNodes
            .map((n) => sourceFile.getFullText().slice(n.getFullStart(), n.getEnd()).trim())
            .join('\n'),
        });
      }
    }

    declarations.sort((left, right) => left.startLine - right.startLine);

    return {
      rootType: 'program',
      declarations,
    };
  }
}

export class TypeScriptLanguagePlugin implements LanguagePlugin {
  readonly languageId = 'typescript';

  readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  supports(filePath: string): boolean {
    return this.fileExtensions.some((extension) => filePath.endsWith(extension));
  }

  async createParser(): Promise<TypeScriptParser> {
    return new TypeScriptParser();
  }
}
