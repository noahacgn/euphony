import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const CONVERSATION_SOURCE_URL = new URL(
  '../../src/components/conversation/conversation.ts',
  import.meta.url
);

const containsIdentifier = (node, identifierText) => {
  if (ts.isIdentifier(node) && node.text === identifierText) {
    return true;
  }

  return node.getChildren().some(child =>
    containsIdentifier(child, identifierText)
  );
};

test('conversation message templates remain flat for long sessions', async () => {
  const sourceText = await readFile(CONVERSATION_SOURCE_URL, 'utf8');
  const sourceFile = ts.createSourceFile(
    CONVERSATION_SOURCE_URL.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const recursiveAssignments = [];

  const visit = node => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === 'messageElements' &&
      containsIdentifier(node.right, 'messageElements')
    ) {
      recursiveAssignments.push(node.getText(sourceFile));
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  assert.deepEqual(
    recursiveAssignments,
    [],
    'Recursively nesting messageElements makes Lit overflow the call stack for long Codex sessions.'
  );
});

test('conversation renders every message without truncation sentinels', async () => {
  const sourceText = await readFile(CONVERSATION_SOURCE_URL, 'utf8');
  const sourceFile = ts.createSourceFile(
    CONVERSATION_SOURCE_URL.pathname,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const messageSlices = [];
  const truncationMessages = [];

  // A slice of the selected message collection silently drops part of a long
  // conversation even though the navigation still exposes every message.
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'curMessages' &&
      node.expression.name.text === 'slice'
    ) {
      messageSlices.push(node.getText(sourceFile));
    }

    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      node.text.toLowerCase().includes('conversation is truncated')
    ) {
      truncationMessages.push(node.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  assert.deepEqual(
    messageSlices,
    [],
    'Conversation rendering must not slice the selected message collection.'
  );
  assert.deepEqual(
    truncationMessages,
    [],
    'Conversation rendering must not insert truncation sentinel messages.'
  );
});
