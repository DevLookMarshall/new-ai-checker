const RELEASE_SIGNALS = [
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

const MODEL_FAMILIES =
	/\b(gpt|chatgpt|claude|sonnet|opus|haiku|gemini|gemma|embeddinggemma|llama|mistral|mixtral|ministral|codestral|deepseek|qwen|qwq|falcon|nemotron|cosmos|grok|command[ -]?r|nova|kimi|glm|aya|phi|copilot|codex|veo|imagen|sora|whisper|daybreak|synthid|weathernext|alphagenome|sima|genie|weather(next)?|nano banana|muse|tribe|bedrock|sagemaker|nemo|nvidia|titan|granite|watsonx|palm|bard)\b/i;

const VERSIONED_PRODUCT = /\b[A-Z][A-Za-z]*(?:[- ]\d+)+(?:\.\d+)*\b/;

const LEADS_WITH_FAMILY =
	/^(?:gpt|chatgpt|claude|gemini|gemma|embeddinggemma|llama|mistral|mixtral|ministral|codestral|deepseek|qwen|qwq|falcon|nemotron|grok|command[ -]?r|nova|kimi|glm|aya|phi|copilot|codex|veo|imagen|sora|whisper|daybreak|synthid|weathernext|alphagenome|sima|genie|lyria|muse|tribe|bedrock|sagemaker|cosmos|nemo|nvidia|titan|granite)\b/i;

const LEADS_WITH_ANNOUNCEMENT = /^\s*(?:introduc|announc|unveil|launch|meet|debut|released)/i;

const MODEL_VOCABULARY =
	/\b(models?|llm|large language model|foundation model|multimodal|open[- ]weights?|open[- ]source|reasoning model)\b/i;

const NON_ANNOUNCEMENT =
	/\b(cuts?|halves|saves?|reduces?|cheaper|faster|costs?|benchmark\w*|compared|how to|guide|tips?|case stud\w+|webinar|podcast|hiring|jobs|customers?|turns?|completes|scaling|boosts?|doubles?|study|harness|adoption|report|recap|conference|keynote|devday|chief|ceo|program|initiative|policy|partnership)\b/i;

export function classifyModelRelease(title) {
	const reasons = [];
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

	const threshold = versioned && (hasReleaseSignal || leadsWithFamily) ? 2 : 3;
	const matched = score >= threshold;

	return { matched, score, threshold, reasons };
}
