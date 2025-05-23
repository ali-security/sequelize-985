import isPlainObject from 'lodash/isPlainObject';
import type { AbstractDialect } from '../dialects/abstract/index.js';
import { escape as escapeSqlValue } from '../sql-string';

type BindOrReplacements = { [key: string]: unknown } | unknown[];

/**
 * Inlines replacements in places where they would be valid SQL values.
 *
 * @param sqlString The SQL that contains the replacements
 * @param dialect The dialect of the SQL
 * @param replacements if provided, this method will replace ':named' replacements & positional replacements (?)
 *
 * @returns The SQL with replacements rewritten in their dialect-specific syntax.
 */
export function injectReplacements(
  sqlString: string,
  dialect: AbstractDialect,
  replacements: BindOrReplacements
): string {
  if (replacements == null) {
    return sqlString;
  }

  if (!Array.isArray(replacements) && !isPlainObject(replacements)) {
    throw new TypeError(`"replacements" must be an array or a plain object, but received ${JSON.stringify(replacements)} instead.`);
  }

  const isNamedReplacements = isPlainObject(replacements);
  const isPositionalReplacements = Array.isArray(replacements);
  let lastConsumedPositionalReplacementIndex = -1;

  let output = '';

  let currentDollarStringTagName = null;
  let isString = false;
  let isColumn = false;
  let previousSliceEnd = 0;
  let isSingleLineComment = false;
  let isCommentBlock = false;

  for (let i = 0; i < sqlString.length; i++) {
    const char = sqlString[i];

    if (isColumn) {
      if (char === dialect.TICK_CHAR_RIGHT) {
        isColumn = false;
      }

      continue;
    }

    if (isString) {
      if (char === '\'' && !isBackslashEscaped(sqlString, i - 1)) {
        isString = false;
      }

      continue;
    }

    if (currentDollarStringTagName !== null) {
      if (char !== '$') {
        continue;
      }

      const remainingString = sqlString.slice(i, sqlString.length);

      const dollarStringStartMatch = remainingString.match(/^\$(?<name>[a-z_][0-9a-z_])?(\$)/i);
      const tagName = dollarStringStartMatch?.groups?.name;
      if (currentDollarStringTagName === tagName) {
        currentDollarStringTagName = null;
      }

      continue;
    }

    if (isSingleLineComment) {
      if (char === '\n') {
        isSingleLineComment = false;
      }

      continue;
    }

    if (isCommentBlock) {
      if (char === '*' && sqlString[i + 1] === '/') {
        isCommentBlock = false;
      }

      continue;
    }

    if (char === dialect.TICK_CHAR_LEFT) {
      isColumn = true;
      continue;
    }

    if (char === '\'') {
      isString = true;
      continue;
    }

    if (char === '-' && sqlString.slice(i, i + 3) === '-- ') {
      isSingleLineComment = true;
      continue;
    }

    if (char === '/' && sqlString.slice(i, i + 2) === '/*') {
      isCommentBlock = true;
      continue;
    }

    // either the start of a $bind parameter, or the start of a $tag$string$tag$
    if (char === '$') {
      const previousChar = sqlString[i - 1];

      // we are part of an identifier
      if (/[0-9a-z_]/i.test(previousChar)) {
        continue;
      }

      const remainingString = sqlString.slice(i, sqlString.length);

      const dollarStringStartMatch = remainingString.match(/^\$(?<name>[a-z_][0-9a-z_]*)?\$/i);
      if (dollarStringStartMatch) {
        currentDollarStringTagName = dollarStringStartMatch.groups?.name ?? '';

        continue;
      }

      continue;
    }

    if (isNamedReplacements && char === ':') {
      const previousChar = sqlString[i - 1];
      // we want to be conservative with what we consider to be a replacement to avoid risk of conflict with potential operators
      // users need to add a space before the bind parameter (except after '(', ',', and '=', '[' (for arrays))
      if (previousChar !== undefined && !/[\s(,=[]/.test(previousChar)) {
        continue;
      }

      const remainingString = sqlString.slice(i, sqlString.length);

      const match = remainingString.match(/^:(?<name>[a-z_][0-9a-z_]*)(?:\)|,|$|\s|::|;|])/i);
      const replacementName = match?.groups?.name;
      if (!replacementName) {
        continue;
      }

      // @ts-expect-error -- isPlainObject does not tell typescript that replacements is a plain object, not an array
      const replacementValue = replacements[replacementName];
      if (!Object.prototype.hasOwnProperty.call(replacements, replacementName) || replacementValue === undefined) {
        throw new Error(`Named replacement ":${replacementName}" has no entry in the replacement map.`);
      }

      const escapedReplacement = escapeSqlValue(replacementValue, undefined, dialect.name, true);

      // add everything before the bind parameter name
      output += sqlString.slice(previousSliceEnd, i);
      // continue after the bind parameter name
      previousSliceEnd = i + replacementName.length + 1;

      output += escapedReplacement;

      continue;
    }

    if (isPositionalReplacements && char === '?') {
      const previousChar = sqlString[i - 1];

      // we want to be conservative with what we consider to be a replacement to avoid risk of conflict with potential operators
      // users need to add a space before the bind parameter (except after '(', ',', and '=', '[' (for arrays))
      if (previousChar !== undefined && !/[\s(,=[]/.test(previousChar)) {
        continue;
      }

      // don't parse ?| and ?& operators as replacements
      const nextChar = sqlString[i + 1];
      if (nextChar === '|' || nextChar === '&') {
        continue;
      }

      const replacementIndex = ++lastConsumedPositionalReplacementIndex;
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore -- ts < 4.4 loses the information that 'replacements' is an array when using 'isPositionalReplacements' instead of 'Array.isArray'
      //  but performance matters here.
      const replacementValue = replacements[lastConsumedPositionalReplacementIndex];

      if (replacementValue === undefined) {
        throw new Error(`Positional replacement (?) ${replacementIndex} has no entry in the replacement map (replacements[${replacementIndex}] is undefined).`);
      }

      const escapedReplacement = escapeSqlValue(replacementValue as any, undefined, dialect.name, true);

      // add everything before the bind parameter name
      output += sqlString.slice(previousSliceEnd, i);
      // continue after the bind parameter name
      previousSliceEnd = i + 1;

      output += escapedReplacement;
    }
  }

  output += sqlString.slice(previousSliceEnd, sqlString.length);

  return output;
}

function isBackslashEscaped(string: string, pos: number): boolean {
  let escaped = false;
  for (let i = pos; i >= 0; i--) {
    const char = string[i];
    if (char !== '\\') {
      break;
    }

    escaped = !escaped;
  }

  return escaped;
}
