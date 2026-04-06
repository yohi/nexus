import ts from 'typescript';
import type { FileToChunk, LanguagePlugin, ParsedDeclaration, ParsedSourceFile, SymbolKind } from '../../types/index.js';

const getLineRange = (sourceFile: ts.SourceFile, node: ts.Node): { startLine: number; endLine: number } => {
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { startLine, endLine };
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
      } else if (ts.isFunctionDeclaration(node) && node.name) {
        type = 'function';
        name = node.name.text;
      } else if (ts.isClassDeclaration(node) && node.name) {
        type = 'class';
        name = node.name.text;
      } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        type = 'method';
        name = node.name.text;
      } else if (ts.isConstructorDeclaration(node)) {
        type = 'constructor';
        name = 'constructor';
      } else if (ts.isGetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
        type = 'method';
        name = `get ${node.name.text}`;
      } else if (ts.isSetAccessorDeclaration(node) && ts.isIdentifier(node.name)) {
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
      } else if (ts.isVariableStatement(node)) {
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (isExported) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              const varName = declaration.name.text;
              const isFunction =
                declaration.initializer &&
                (ts.isArrowFunction(declaration.initializer) ||
                  ts.isFunctionExpression(declaration.initializer) ||
                  ts.isCallExpression(declaration.initializer));

              const { startLine, endLine } = getLineRange(sourceFile, declaration);
              declarations.push({
                type: isFunction ? 'function' : 'variable',
                name: varName,
                startLine,
                endLine,
                content: declaration.getText(sourceFile).trim(),
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
          content: node.getText(sourceFile).trim(),
        });
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (importNodes.length > 0) {
      const firstImport = importNodes[0]!;
      const lastImport = importNodes[importNodes.length - 1]!;
      const { startLine } = getLineRange(sourceFile, firstImport);
      const { endLine } = getLineRange(sourceFile, lastImport);

      declarations.push({
        type: 'import',
        name: 'imports',
        startLine,
        endLine,
        content: importNodes.map((n) => n.getText(sourceFile).trim()).join('\n'),
      });
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
