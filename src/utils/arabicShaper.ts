// Arabic Letter Shaper and Reverser for jsPDF Arabic Support
// This utility maps Arabic Unicode characters to their correct contextual presentation forms and reverses them for RTL rendering.

export const ARABIC_LIGHT_MAP: { [key: number]: { isolated: number; initial: number; medial: number; final: number; connectBefore: boolean; connectAfter: boolean } } = {
  0x0621: { isolated: 0xFE80, initial: 0xFE80, medial: 0xFE80, final: 0xFE80, connectBefore: false, connectAfter: false }, // ء
  0x0622: { isolated: 0xFE81, initial: 0xFE81, medial: 0xFE82, final: 0xFE82, connectBefore: true, connectAfter: false }, // آ
  0x0623: { isolated: 0xFE83, initial: 0xFE83, medial: 0xFE84, final: 0xFE84, connectBefore: true, connectAfter: false }, // أ
  0x0624: { isolated: 0xFE85, initial: 0xFE85, medial: 0xFE86, final: 0xFE86, connectBefore: true, connectAfter: false }, // ؤ
  0x0625: { isolated: 0xFE87, initial: 0xFE87, medial: 0xFE88, final: 0xFE88, connectBefore: true, connectAfter: false }, // إ
  0x0626: { isolated: 0xFE89, initial: 0xFE8B, medial: 0xFE8C, final: 0xFE8A, connectBefore: true, connectAfter: true },  // ئ
  0x0627: { isolated: 0xFE8D, initial: 0xFE8D, medial: 0xFE8E, final: 0xFE8E, connectBefore: true, connectAfter: false }, // ا
  0x0628: { isolated: 0xFE8F, initial: 0xFE91, medial: 0xFE92, final: 0xFE90, connectBefore: true, connectAfter: true },  // ب
  0x0629: { isolated: 0xFE93, initial: 0xFE93, medial: 0xFE94, final: 0xFE94, connectBefore: true, connectAfter: false }, // ة
  0x062A: { isolated: 0xFE95, initial: 0xFE97, medial: 0xFE98, final: 0xFE96, connectBefore: true, connectAfter: true },  // ت
  0x062B: { isolated: 0xFE99, initial: 0xFE9B, medial: 0xFE9C, final: 0xFE9A, connectBefore: true, connectAfter: true },  // ث
  0x062C: { isolated: 0xFE9D, initial: 0xFE9F, medial: 0xFEA0, final: 0xFE9E, connectBefore: true, connectAfter: true },  // ج
  0x062D: { isolated: 0xFEA1, initial: 0xFEA3, medial: 0xFEA4, final: 0xFEA2, connectBefore: true, connectAfter: true },  // ح
  0x062E: { isolated: 0xFEA5, initial: 0xFEA7, medial: 0xFEA8, final: 0xFEA6, connectBefore: true, connectAfter: true },  // خ
  0x062F: { isolated: 0xFEA9, initial: 0xFEA9, medial: 0xFEAA, final: 0xFEAA, connectBefore: true, connectAfter: false }, // د
  0x0630: { isolated: 0xFEAB, initial: 0xFEAB, medial: 0xFEAC, final: 0xFEAC, connectBefore: true, connectAfter: false }, // ذ
  0x0631: { isolated: 0xFEAD, initial: 0xFEAD, medial: 0xFEAE, final: 0xFEAE, connectBefore: true, connectAfter: false }, // ر
  0x0632: { isolated: 0xFEAF, initial: 0xFEAF, medial: 0xFEB0, final: 0xFEB0, connectBefore: true, connectAfter: false }, // ز
  0x0633: { isolated: 0xFEB1, initial: 0xFEB3, medial: 0xFEB4, final: 0xFEB2, connectBefore: true, connectAfter: true },  // س
  0x0634: { isolated: 0xFEB5, initial: 0xFEB7, medial: 0xFEB8, final: 0xFEB6, connectBefore: true, connectAfter: true },  // ش
  0x0635: { isolated: 0xFEB9, initial: 0xFEBB, medial: 0xFEBC, final: 0xFEBA, connectBefore: true, connectAfter: true },  // ص
  0x0636: { isolated: 0xFEBD, initial: 0xFEBF, medial: 0xFEC0, final: 0xFEBE, connectBefore: true, connectAfter: true },  // ض
  0x0637: { isolated: 0xFEC1, initial: 0xFEC3, medial: 0xFEC4, final: 0xFEC2, connectBefore: true, connectAfter: true },  // ط
  0x0638: { isolated: 0xFEC5, initial: 0xFEC7, medial: 0xFEC8, final: 0xFEC6, connectBefore: true, connectAfter: true },  // ظ
  0x0639: { isolated: 0xFEC9, initial: 0xFECB, medial: 0xFECC, final: 0xFECA, connectBefore: true, connectAfter: true },  // ع
  0x063A: { isolated: 0xFECD, initial: 0xFECF, medial: 0xFED0, final: 0xFECE, connectBefore: true, connectAfter: true },  // غ
  0x0641: { isolated: 0xFED1, initial: 0xFED3, medial: 0xFED4, final: 0xFED2, connectBefore: true, connectAfter: true },  // ف
  0x0642: { isolated: 0xFED5, initial: 0xFED7, medial: 0xFED8, final: 0xFED6, connectBefore: true, connectAfter: true },  // ق
  0x0643: { isolated: 0xFED9, initial: 0xFEDB, medial: 0xFEDC, final: 0xFEDA, connectBefore: true, connectAfter: true },  // ك
  0x0644: { isolated: 0xFEDD, initial: 0xFEDF, medial: 0xFEE0, final: 0xFEDE, connectBefore: true, connectAfter: true },  // ل
  0x0645: { isolated: 0xFEE1, initial: 0xFEE3, medial: 0xFEE4, final: 0xFEE2, connectBefore: true, connectAfter: true },  // م
  0x0646: { isolated: 0xFEE5, initial: 0xFEE7, medial: 0xFEE8, final: 0xFEE6, connectBefore: true, connectAfter: true },  // ن
  0x0647: { isolated: 0xFEE9, initial: 0xFEEB, medial: 0xFEEC, final: 0xFEEA, connectBefore: true, connectAfter: true },  // هـ
  0x0648: { isolated: 0xFEED, initial: 0xFEED, medial: 0xFEEE, final: 0xFEEE, connectBefore: true, connectAfter: false }, // و
  0x0649: { isolated: 0xFEEF, initial: 0xFEEF, medial: 0xFEF0, final: 0xFEF0, connectBefore: true, connectAfter: false }, // ى
  0x064A: { isolated: 0xFEF1, initial: 0xFEF3, medial: 0xFEF4, final: 0xFEF2, connectBefore: true, connectAfter: true },  // ي
};

// Returns whether a character at index in word can connect to previous character
function canConnectBefore(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  const mapItem = ARABIC_LIGHT_MAP[code];
  return mapItem ? mapItem.connectBefore : false;
}

// Returns whether a character at index in word can connect to next character
function canConnectAfter(char: string | undefined): boolean {
  if (!char) return false;
  if (char.length > 1) return false; // Laam-Alif ligature never connects after
  const code = char.charCodeAt(0);
  const mapItem = ARABIC_LIGHT_MAP[code];
  return mapItem ? mapItem.connectAfter : false;
}

export function shapeArabicText(text: string): string {
  if (!text) return '';

  // Process Arabic shaping and reverse lines to support RTL in jsPDF
  // We split by lines then reshape words while preserving non-Arabic tokens (such as numbers/latins)
  const lines = text.split('\n');
  const processedLines = lines.map(line => {
    // Tokenize line into words, numbers, and punctuation to prevent reversing digits
    const tokens = tokenizeLine(line);
    
    // Process and reverse Arabic tokens, leave non-Arabic tokens in standard order
    // But since Arabic reads Right-To-Left, the visual order of tokens in the line must be reversed
    const processedTokens = tokens.map(token => {
      if (isArabicToken(token)) {
        return shapeArabicWord(token);
      }
      // Swap brackets or parentheses visually in LTR chunks that are read in RTL context
      return token.split('').map(swapBrackets).join('');
    });

    // Reverse token array so they layout RTL
    return processedTokens.reverse().join('');
  });

  return processedLines.join('\n');
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

function isArabicToken(token: string): boolean {
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (code >= 0x0600 && code <= 0x06FF) {
      return true;
    }
  }
  return false;
}

function tokenizeLine(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    const code = char.charCodeAt(0);
    
    // Check if Arabic
    const isAr = (code >= 0x0600 && code <= 0x06FF) || (code >= 0xFE70 && code <= 0xFEFC);
    
    // Check if alphanumeric/identifier (English letters or digits, including standard boundaries)
    const isAlphanumChar = (charStr: string) => {
      const c = charStr.charCodeAt(0);
      return (c >= 48 && c <= 57) || // 0-9
             (c >= 65 && c <= 90) || // A-Z
             (c >= 97 && c <= 122) || // a-z
             c === 45 || c === 58 || c === 46 || c === 47; // hyphens, colons, dots, slashes inside number
    };

    if (isAr) {
      let arabicWord = '';
      while (i < line.length) {
        const c = line[i];
        const cCode = c.charCodeAt(0);
        if ((cCode >= 0x0600 && cCode <= 0x06FF) || (cCode >= 0xFE70 && cCode <= 0xFEFC)) {
          arabicWord += c;
          i++;
        } else {
          break;
        }
      }
      tokens.push(arabicWord);
    } else if (isAlphanumChar(char)) {
      let nonArWord = '';
      while (i < line.length && isAlphanumChar(line[i])) {
        nonArWord += line[i];
        i++;
      }
      tokens.push(nonArWord);
    } else {
      // Spaces or individual punctuation characters
      tokens.push(char);
      i++;
    }
  }
  return tokens;
}

function shapeArabicWord(word: string): string {
  const chars = combineLaamAlif(word);
  const shaped: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const currChar = chars[i];
    const prevChar = chars[i - 1];
    const nextChar = chars[i + 1];

    if (currChar.length > 1) {
      // It is a Laam-Alif ligature
      const connectsPrev = i > 0 && canConnectAfter(prevChar);
      let finalCharCode = 0xFEFB; // Default plain isolated 'لا'
      
      if (currChar === 'لآ') {
        finalCharCode = connectsPrev ? 0xFEF6 : 0xFEF5;
      } else if (currChar === 'لأ') {
        finalCharCode = connectsPrev ? 0xFEF8 : 0xFEF7;
      } else if (currChar === 'لإ') {
        finalCharCode = connectsPrev ? 0xFEFA : 0xFEF9;
      } else { // 'لا'
        finalCharCode = connectsPrev ? 0xFEFC : 0xFEFB;
      }
      
      shaped.push(String.fromCharCode(finalCharCode));
      continue;
    }

    const code = currChar.charCodeAt(0);
    const mapItem = ARABIC_LIGHT_MAP[code];

    if (!mapItem) {
      shaped.push(currChar);
      continue;
    }

    // Determine connection state
    const connectsPrev = i > 0 && mapItem.connectBefore && canConnectAfter(prevChar);
    const connectsNext = i < chars.length - 1 && mapItem.connectAfter && canConnectBefore(nextChar);

    let finalCharCode = code;
    if (connectsPrev && connectsNext) {
      finalCharCode = mapItem.medial;
    } else if (connectsPrev) {
      finalCharCode = mapItem.final;
    } else if (connectsNext) {
      finalCharCode = mapItem.initial;
    } else {
      finalCharCode = mapItem.isolated;
    }

    shaped.push(String.fromCharCode(finalCharCode));
  }

  // Reverse letters of the word for true RTL layout in standard Canvas drawers
  return shaped.reverse().join('');
}

function combineLaamAlif(word: string): string[] {
  const chars = word.split('');
  const combined: string[] = [];
  let i = 0;
  while (i < chars.length) {
    if (i < chars.length - 1 && chars[i] === 'ل') {
      const next = chars[i + 1];
      if (next === 'ا' || next === 'أ' || next === 'إ' || next === 'آ') {
        combined.push('ل' + next);
        i += 2;
        continue;
      }
    }
    combined.push(chars[i]);
    i++;
  }
  return combined;
}

// Convert ArrayBuffer to Base64 (needed to register Cairo ttf dynamically inside PDF generator)
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}
