// Arabic PDF Text Recovery & Repair Utility
// Replaces Arabic presentation forms back to standard baseline unicode and fixes the reversed character flow.

import { ARABIC_LIGHT_MAP } from './arabicShaper';

// Initialize a reverse map of Presentation Form unicode points directly to the standard baseline Arabic character
const REVERSE_ARABIC_MAP: { [key: number]: string } = {};

// 1. Map characters from original ARABIC_LIGHT_MAP
for (const [baselineCodeStr, forms] of Object.entries(ARABIC_LIGHT_MAP)) {
  const baselineCode = parseInt(baselineCodeStr);
  const baselineChar = String.fromCharCode(baselineCode);
  
  if (forms.isolated) REVERSE_ARABIC_MAP[forms.isolated] = baselineChar;
  if (forms.initial) REVERSE_ARABIC_MAP[forms.initial] = baselineChar;
  if (forms.medial) REVERSE_ARABIC_MAP[forms.medial] = baselineChar;
  if (forms.final) REVERSE_ARABIC_MAP[forms.final] = baselineChar;
}

// 2. Add Laam-Alif Ligatures (Presentation Form Forms-B)
REVERSE_ARABIC_MAP[0xFEF5] = 'لآ';
REVERSE_ARABIC_MAP[0xFEF6] = 'لآ';
REVERSE_ARABIC_MAP[0xFEF7] = 'لأ';
REVERSE_ARABIC_MAP[0xFEF8] = 'لأ';
REVERSE_ARABIC_MAP[0xFEF9] = 'لإ';
REVERSE_ARABIC_MAP[0xFEFA] = 'لإ';
REVERSE_ARABIC_MAP[0xFEFB] = 'لا';
REVERSE_ARABIC_MAP[0xFEFC] = 'لا';

/**
 * Repairs reversed and disconnected Arabic text copied or extracted from PDFs.
 * It identifies blocks of Arabic glyphs (including presentation forms), remaps them,
 * and fixes the character-by-character direction inversion while preserving English/Numbers correctly.
 */
export function fixArabicPdfText(text: string): string {
  if (!text) return '';

  // Step 1: Normalize all Presentation Forms back to basic standard letters
  let normalizedText = '';
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    if (REVERSE_ARABIC_MAP[charCode]) {
      normalizedText += REVERSE_ARABIC_MAP[charCode];
    } else {
      normalizedText += text[i];
    }
  }

  // Step 2: Line-by-line BiDi resolution
  const lines = normalizedText.split('\n');
  const correctedLines = lines.map(line => {
    // Return empty line immediately
    if (!line.trim()) return line;

    // Segment line into consecutive Arabic vs Non-Arabic blocks
    const tokens: string[] = [];
    let curToken = '';
    let curIsArabic = false;

    const isArabicChar = (c: string) => {
      const code = c.charCodeAt(0);
      return (code >= 0x0600 && code <= 0x06FF) || (code >= 0xFE70 && code <= 0xFEFC);
    };

    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const isAr = isArabicChar(c);
      
      if (i === 0) {
        curIsArabic = isAr;
        curToken = c;
      } else if (isAr === curIsArabic) {
        curToken += c;
      } else {
        tokens.push(curToken);
        curIsArabic = isAr;
        curToken = c;
      }
    }
    if (curToken) {
      tokens.push(curToken);
    }

    // Process tokens. Since the PDF was drawn left-to-right (thereby reversing things),
    // and copying reads visually left-to-right:
    // 1. Any Arabic segment was reversed character-by-character, so we must reverse its characters.
    // 2. Non-Arabic segments (numbers, english words) were NOT reversed in their sub-blocks, so we keep them as is.
    // 3. The overall run layout reading flow gets reversed.
    const correctedTokens = tokens.map(token => {
      if (token.split('').some(isArabicChar)) {
        // Reverse standard Arabic word characters
        return token.split('').reverse().join('');
      } else {
        // Keep numbers or latin words as they are
        return token;
      }
    });

    // Mirroring of brackets/parentheses for correct orientation
    const finalTokens = correctedTokens.map(token => {
      // If a non-Arabic token has brackets, swap them to match the RTL overall reversal orientation
      if (!token.split('').some(isArabicChar)) {
        return token.split('').map(swapBrackets).join('');
      }
      return token;
    });

    // Finally reverse the sequence of runs to restore RTL alignment
    return finalTokens.reverse().join('');
  });

  return correctedLines.join('\n');
}

function swapBrackets(char: string): string {
  if (char === '(') return ')';
  if (char === ')') return '(';
  if (char === '[') return ']';
  if (char === ']') return '[';
  if (char === '{') return '}';
  if (char === '}') return '{';
  if (char === '<') return '>';
  if (char === '>') return '<';
  return char;
}
