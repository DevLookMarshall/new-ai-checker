import type { Classification } from './classifier.ts';
import type { Env, FeedItem } from './config.ts';

export interface PersianAnalysis {
	titleFa: string;
	descriptionFa: string;
	analysisFa: string;
	usedLlm: boolean;
}

export async function translateToPersian(text: string): Promise<string | null> {
	const cleaned = text.trim();
	if (!cleaned) return '';

	try {
		const q = encodeURIComponent(cleaned.slice(0, 1800));
		const response = await fetch(
			`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t&q=${q}`,
			{ signal: AbortSignal.timeout(8_000) },
		);
		if (!response.ok) return null;
		const data = (await response.json()) as unknown;
		if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
		const translated = (data[0] as unknown[])
			.map((segment) => (Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : ''))
			.join('')
			.trim();
		return translated || null;
	} catch {
		return null;
	}
}

function detectCategory(text: string): string {
	const lower = text.toLowerCase();
	if (/\b(video|sora|veo|runway|animation|frame|3d)\b/.test(lower)) {
		return 'تولید و پردازش ویدیو / چندوجهی';
	}
	if (/\b(image|imagen|vision|photo|diffusion|banana|flux)\b/.test(lower)) {
		return 'تولید و درک تصویر';
	}
	if (/\b(code|coding|codex|codestral|developer|swe|agent|cli|programming)\b/.test(lower)) {
		return 'کدنویسی، مهندسی نرم‌افزار و ایجنت‌ها';
	}
	if (/\b(audio|speech|voice|whisper|music|lyria|asr|tts)\b/.test(lower)) {
		return 'صوت، گفتار و موسیقی';
	}
	if (/\b(open[- ]weights?|open[- ]source|gemma|llama|qwen|mistral|falcon|deepseek)\b/.test(lower)) {
		return 'مدل وزن‌باز (Open-Weights / قابل اجرا روی سرور شخصی)';
	}
	if (/\b(reasoning|thinking|math|science|frontier|gpt|claude|gemini|grok|llm)\b/.test(lower)) {
		return 'مدل زبانی و استدلالی پیشرفته (LLM / Reasoning)';
	}
	return 'مدل و فناوری جدید هوش مصنوعی';
}

export function buildDeterministicAnalysis(source: string, item: FeedItem, classification?: Classification): string {
	const combined = `${item.title} ${item.description ?? ''}`;
	const category = detectCategory(combined);
	const lower = combined.toLowerCase();

	const highlights: string[] = [];
	if (/\b(open[- ]weights?|open[- ]source)\b/.test(lower)) {
		highlights.push('امکان دانلود وزن‌ها و اجرای محلی/اختصاصی بدون وابستگی کامل به API');
	}
	if (/\b(reasoning|thinking|deep|pro|ultra|opus|sonnet|flagship|frontier)\b/.test(lower)) {
		highlights.push('تمرکز بر استدلال عمیق‌تر و حل مسائل پیچیده چندمرحله‌ای');
	}
	if (/\b(mini|flash|nano|haiku|fast|light|efficient|small)\b/.test(lower)) {
		highlights.push('بهینه‌شده برای سرعت بالا و هزینه پایین‌تر در مقیاس عملیاتی');
	}
	if (/\b(code|coding|agent|tool|computer use|browser|api)\b/.test(lower)) {
		highlights.push('مناسب برای اتوماسیون، کدنویسی خودکار و ساخت ایجنت‌های هوشمند');
	}
	if (/\b(multimodal|vision|audio|video|image)\b/.test(lower)) {
		highlights.push('پشتیبانی چندوجهی (پردازش هم‌زمان متن، تصویر، صوت یا ویدیو)');
	}
	if (highlights.length === 0) {
		highlights.push(`عرضه جدید از تیم ${source} با تمرکز بر بهبود کیفیت و کارایی مدل‌های هوش مصنوعی`);
	}

	const scoreLine = classification
		? `امتیاز رادار: ${classification.score}/${classification.threshold}`
		: 'شناسایی‌شده توسط رادار مدل‌ها';

	return [
		`• دسته: ${category}`,
		`• ارزیابی: ${highlights.slice(0, 2).join('؛ ')}`,
		`• وضعیت: ${scoreLine}`,
	].join('\n');
}

async function analyzeWithGemini(apiKey: string, source: string, item: FeedItem): Promise<PersianAnalysis | null> {
	try {
		const prompt = [
			'You are an AI model analyst writing concise Persian (Farsi) for a Telegram channel.',
			`Source: ${source}`,
			`Title: ${item.title}`,
			`Summary: ${item.description ?? ''}`,
			'Respond strictly as JSON with keys "titleFa" (accurate Persian translation of title), "descriptionFa" (concise 1-2 sentence Persian translation of summary), and "analysisFa" (2-3 short Persian bullet points starting with "• " analyzing category, why it matters, and practical use cases).',
		].join('\n');

		const response = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					contents: [{ parts: [{ text: prompt }] }],
					generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
				}),
				signal: AbortSignal.timeout(12_000),
			},
		);
		if (!response.ok) return null;
		const json = (await response.json()) as {
			candidates?: { content?: { parts?: { text?: string }[] } }[];
		};
		const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) return null;
		const parsed = JSON.parse(text) as { titleFa?: string; descriptionFa?: string; analysisFa?: string };
		if (!parsed.titleFa || !parsed.analysisFa) return null;
		return {
			titleFa: parsed.titleFa.trim(),
			descriptionFa: (parsed.descriptionFa ?? '').trim(),
			analysisFa: parsed.analysisFa.trim(),
			usedLlm: true,
		};
	} catch {
		return null;
	}
}

async function analyzeWithOpenAi(apiKey: string, source: string, item: FeedItem): Promise<PersianAnalysis | null> {
	try {
		const prompt = [
			`Source: ${source}`,
			`Title: ${item.title}`,
			`Summary: ${item.description ?? ''}`,
			'Return JSON with keys: "titleFa" (Persian title translation), "descriptionFa" (concise Persian summary translation), "analysisFa" (2-3 short Persian bullet points starting with "• " covering category, impact, and use cases).',
		].join('\n');

		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: 'gpt-4o-mini',
				response_format: { type: 'json_object' },
				temperature: 0.3,
				messages: [
					{
						role: 'system',
						content: 'You are an expert AI industry analyst writing concise, accurate Persian (Farsi) for a Telegram channel.',
					},
					{ role: 'user', content: prompt },
				],
			}),
			signal: AbortSignal.timeout(12_000),
		});
		if (!response.ok) return null;
		const json = (await response.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		const text = json.choices?.[0]?.message?.content;
		if (!text) return null;
		const parsed = JSON.parse(text) as { titleFa?: string; descriptionFa?: string; analysisFa?: string };
		if (!parsed.titleFa || !parsed.analysisFa) return null;
		return {
			titleFa: parsed.titleFa.trim(),
			descriptionFa: (parsed.descriptionFa ?? '').trim(),
			analysisFa: parsed.analysisFa.trim(),
			usedLlm: true,
		};
	} catch {
		return null;
	}
}

export async function analyzeReleasePersian(
	source: string,
	item: FeedItem,
	classification?: Classification,
	env?: Partial<Env>,
): Promise<PersianAnalysis> {
	if (env?.GEMINI_API_KEY) {
		const llm = await analyzeWithGemini(env.GEMINI_API_KEY, source, item);
		if (llm) return llm;
	}
	if (env?.OPENAI_API_KEY) {
		const llm = await analyzeWithOpenAi(env.OPENAI_API_KEY, source, item);
		if (llm) return llm;
	}

	const [titleFa, descriptionFa] = await Promise.all([
		translateToPersian(item.title),
		item.description ? translateToPersian(item.description) : Promise.resolve(''),
	]);

	return {
		titleFa: titleFa || item.title,
		descriptionFa: descriptionFa || item.description || '',
		analysisFa: buildDeterministicAnalysis(source, item, classification),
		usedLlm: false,
	};
}
