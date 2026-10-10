/**
 * Heuristic "is this headline a model release?" scorer.
 *
 * The previous implementation required *both* a hardcoded release phrase AND a
 * hardcoded model name, which measured 1/40 recall on OpenAI's feed and missed
 * flagship launches such as "GPT-6 and Intelligent UI for everyone" and
 * "Gemini 4 Argon: our next era of frontier intelligence".
 *
 * This version scores a headline instead:
 *   +2 release signal (introducing / launching / now available / …)
 *   +2 versioned product name ("GPT-6.1", "Gemini 3.8", "WeatherNext 3")
 *   +2 headline *starts* with that product name (typical announcement shape)
 *   +1 known model family (claude, gemini, llama, qwen, …)
 *   +1 explicit model vocabulary (model / LLM / open-weights / …)
 *   −1 per case-study / non-announcement cue ("cuts costs", "how to", "guide"…)
 *
 * A versioned product name lowers the acceptance threshold from 3 to 2, so
 * "GPT-6 and Intelligent UI for everyone" passes while
 * "Asana cuts model costs 76x in browser tests with GPT-6.1 Sol" does not.
 *
 * Deliberately title-only: feed descriptions mention model names in every case
 * study, and scoring them caused false positives.
 */

export interface Classification {
	matched: boolean;
	score: number;
	threshold: number;
	reasons: string[];
}

const RELEASE_SIGNALS: { name: string; pattern: RegExp }[] = [
	{ name: 'introducing', pattern: /\bintroduc(e|es|ed|ing|tion)\b/i },
	{ name: 'announcing', pattern: /\bannounc(e|es|ed|ing)\b/i },
	{ name: 'launching', pattern: /\blaunch(es|ed|ing)?\b/i },
	{ name: 'unveiling', pattern: /\bunveil(s|ed|ing)?\b/i },
	{ name: 'debut', pattern: /\bdebut(s|ed|ing)?\b/i },
	{ name: 'availability', pattern: /\b(now available|available now|available to|rolling out|starts? today|is live|goes live)\b/i },
	{ name: 'release', pattern: /\brelease(s|d|ing)?\b|\breleasing\b/i },
	{ name: 'announcement', pattern: /\b(meet (the|our)|all[- ]new|is here|say hello to|hello to)\b/i },
	{ name: 'open-weights', pattern: /\bopen[- ]weights?\b|\bopen[- ]source\b/i },
];

/** Known model families. Word-boundary matched, case-insensitive, worth +1 each. */
const MODEL_FAMILIES =
	/\b(gpt|chatgpt|claude|sonnet|opus|haiku|gemini|gemma|embeddinggemma|llama|mistral|mixtral|deepseek|qwen|grok|command[ -]?r|nova|kimi|glm|aya|phi|copilot|codex|veo|imagen|sora|whisper|daybreak|synthid|weathernext|alphagenome|sima|genie|weather(next)?|nano banana|muse|tribe)\b/i;

/** "GPT-6.1", "Gemini 3.8", "WeatherNext 3", "Nano Banana 2" — capitalised name + version. */
const VERSIONED_PRODUCT = /\b[A-Z][A-Za-z]*(?:[- ]\d+)+(?:\.\d+)*\b/;

/** Headline opens with a *known model family* — the canonical announcement shape. */
const LEADS_WITH_FAMILY =
	/^(?:gpt|chatgpt|claude|gemini|gemma|embeddinggemma|llama|mistral|mixtral|deepseek|qwen|grok|command[ -]?r|nova|kimi|glm|aya|phi|copilot|codex|veo|imagen|sora|whisper|daybreak|synthid|weathernext|alphagenome|sima|genie|lyria|muse|tribe)\b/i;

/** Headline itself opens with the announcement verb ("Introducing …"), worth +1 extra. */
const LEADS_WITH_ANNOUNCEMENT = /^\s*(?:introduc|announc|unveil|launch|meet|debut|released)/i;

const MODEL_VOCABULARY = /\b(models?|llm|large language model|foundation model|multimodal|open[- ]weights?|open[- ]source|reasoning model)\b/i;

/** Non-announcement cues: case studies, comparisons, tutorials, corporate news. */
const NON_ANNOUNCEMENT =
	/\b(cuts?|halves|saves?|reduces?|cheaper|faster|costs?|benchmark\w*|compared|how to|guide|tips?|case stud\w+|webinar|podcast|hiring|jobs|customers?|turns?|completes|scaling|boosts?|doubles?|study|harness|adoption|report|recap|conference|keynote|devday|chief|ceo|program|initiative|policy|partnership)\b/i;

export function classifyModelRelease(title: string): Classification {
	const reasons: string[] = [];
	let score = 0;

	const hasReleaseSignal = RELEASE_SIGNALS.some((signal) => {
		if (!signal.pattern.test(title)) return false;
		score += 2;
		reasons.push(`release-signal:${signal.name}(+2)`);
		return true;
	});

	const versioned = VERSIONED_PRODUCT.test(title);
	if (versioned) {
		score += 2;
		reasons.push('versioned-product(+2)');
	}

	const leadsWithFamily = LEADS_WITH_FAMILY.test(title);
	if (leadsWithFamily && versioned) {
		score += 2;
		reasons.push('leads-with-model(+2)');
	}

	if (hasReleaseSignal && LEADS_WITH_ANNOUNCEMENT.test(title)) {
		score += 1;
		reasons.push('announcement-headline(+1)');
	}

	if (MODEL_FAMILIES.test(title)) {
		score += 1;
		reasons.push('model-family(+1)');
	}

	if (MODEL_VOCABULARY.test(title)) {
		score += 1;
		reasons.push('model-vocabulary(+1)');
	}

	const penaltyMatches = title.match(new RegExp(NON_ANNOUNCEMENT.source, 'gi')) ?? [];
	if (penaltyMatches.length > 0) {
		const penalty = Math.min(penaltyMatches.length, 3);
		score -= penalty;
		reasons.push(`non-announcement(${penaltyMatches.map((m) => m.toLowerCase()).join(',')})(-${penalty})`);
	}

	// A versioned name only lowers the bar when the headline is shaped like an
	// announcement (release verb, or it opens with the model itself). Otherwise
	// "Asana cuts model costs 76x … with GPT-6.1 Sol" would qualify on version alone.
	const threshold = versioned && (hasReleaseSignal || leadsWithFamily) ? 2 : 3;
	const matched = score >= threshold;

	return { matched, score, threshold, reasons };
}
