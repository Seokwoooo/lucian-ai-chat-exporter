// Runs the compression lab on synthetic conversations (no real data): `npm run lab`.
import { englishScenario, koreanScenario } from '../../tests/fixtures/handoff-scenarios';
import { makeConversation } from '../../tests/fixtures/synthetic';
import { formatLossless, formatSummary, runLab } from './lab';

const convs = [koreanScenario(), englishScenario(), makeConversation(60_000), makeConversation(150_000)];
const { summary, lossless } = await runLab(convs, { minTokens: 12_000, ratios: [0.05, 0, 0.1, 0.2] });
console.log(formatSummary(summary));
console.log(formatLossless(lossless));
