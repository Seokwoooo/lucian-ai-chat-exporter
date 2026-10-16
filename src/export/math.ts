// KaTeX → MathML (Chrome renders MathML natively, so no fonts or CSS need to be bundled).
import katex from 'katex';

export function renderMathMl(tex: string, display: boolean): string | null {
  try {
    return katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: true, strict: 'ignore', trust: false });
  } catch {
    return null;
  }
}
