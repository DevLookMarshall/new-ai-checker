(function () {
	const tg = window.Telegram && window.Telegram.WebApp;
	if (tg) {
		tg.ready();
		tg.expand();
	}

	const scanBtn = document.getElementById('scan-btn');
	const subBtn = document.getElementById('sub-btn');
	const subBadge = document.getElementById('sub-badge');
	const banner = document.getElementById('status-banner');
	const statHealthy = document.getElementById('stat-healthy');
	const statReleases = document.getElementById('stat-releases');
	const statChannels = document.getElementById('stat-channels');
	const aiModeBadge = document.getElementById('ai-mode-badge');
	const lastScan = document.getElementById('last-scan');
	const releasesList = document.getElementById('releases-list');
	const sourcesGrid = document.getElementById('sources-grid');
	const customText = document.getElementById('custom-text');
	const customAnalyzeBtn = document.getElementById('custom-analyze-btn');
	const customAnalysisResult = document.getElementById('custom-analysis-result');
	const channelInput = document.getElementById('channel-input');
	const addChannelBtn = document.getElementById('add-channel-btn');
	const channelsList = document.getElementById('channels-list');

	let currentSubscribed = false;
	let latestDashboard = null;

	function showBanner(text, isError) {
		banner.hidden = false;
		banner.textContent = text;
		banner.className = isError ? 'banner error' : 'banner';
	}

	function callEndpoint(name, input) {
		return new Promise((resolve, reject) => {
			if (!tg || !tg.Serverless || typeof tg.Serverless.call !== 'function') {
				reject(new Error('این صفحه باید از داخل ربات تلگرام باز شود.'));
				return;
			}
			tg.Serverless.call(name, input || {}, function (err, res) {
				if (err) {
					reject(new Error(err.message || 'خطای سرور'));
					return;
				}
				resolve(res);
			});
		});
	}

	function formatTime(iso) {
		if (!iso) return 'بدون اسکن';
		try {
			return new Date(iso).toLocaleString('fa-IR', {
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
			});
		} catch {
			return iso;
		}
	}

	function escapeText(value) {
		const div = document.createElement('div');
		div.textContent = value == null ? '' : String(value);
		return div.innerHTML;
	}

	function renderChannels(channels) {
		if (!channels || channels.length === 0) {
			channelsList.innerHTML = '<p class="empty">هنوز کانالی متصل نشده است.</p>';
			return;
		}
		channelsList.innerHTML = channels
			.map(function (ch) {
				return (
					`<div class="channel-row">` +
					`<div><strong>${escapeText(ch.label)}</strong> <span class="channel-id">(${escapeText(ch.chatId)})</span></div>` +
					`<button class="btn btn-danger" type="button" data-remove-channel="${escapeText(ch.chatId)}">حذف</button>` +
					`</div>`
				);
			})
			.join('');
	}

	function renderDashboard(data) {
		if (!data) return;
		latestDashboard = data;
		currentSubscribed = Boolean(data.isSubscribed);

		subBadge.textContent = currentSubscribed ? 'اعلان فعال' : 'اعلان غیرفعال';
		subBadge.className = currentSubscribed ? 'pill pill-ok' : 'pill pill-muted';
		subBtn.textContent = currentSubscribed ? '🔕 لغو اعلان‌ها' : '🔔 فعال‌سازی اعلان‌ها';

		const stats = data.stats || {};
		statHealthy.textContent = `${stats.healthySources ?? 0}/${stats.totalSources ?? 9}`;
		statReleases.textContent = String((data.releases || []).length);
		statChannels.textContent = String(stats.totalChannels ?? (data.channels || []).length);
		aiModeBadge.textContent = data.aiConfigured ? `تحلیل با ${data.aiProvider}` : 'مترجم + تحلیلگر داخلی';
		lastScan.textContent = `آخرین اسکن: ${formatTime(stats.lastScanAt)}`;

		renderChannels(data.channels || []);

		const releases = data.releases || [];
		if (releases.length === 0) {
			releasesList.innerHTML =
				'<p class="empty">هنوز مدلی ثبت نشده است. روی «اسکن زنده منابع» بزنید تا خط پایه ثبت و مدل‌های جدید رصد شوند.</p>';
		} else {
			releasesList.innerHTML = releases
				.map(function (item) {
					const titleFa = item.titleFa
						? `<p class="release-title-fa">🇮🇷 ${escapeText(item.titleFa)}</p>`
						: '';
					const desc = item.descriptionFa || item.description;
					const descHtml = desc ? `<p class="release-desc">${escapeText(desc)}</p>` : '';
					const analysisHtml = item.analysisFa
						? `<div class="analysis-box">📊 تحلیل رادار:\n${escapeText(item.analysisFa)}</div>`
						: '';
					const analyzeBtn = item.analysisFa
						? ''
						: `<button class="btn btn-secondary btn-sm" type="button" data-analyze-id="${escapeText(item.id)}">🧠 ترجمه و تحلیل فارسی</button>`;
					const date = item.pubDate ? `<span class="release-date">${escapeText(item.pubDate)}</span>` : '';

					return (
						`<article class="release-item">` +
						`<div class="release-meta"><span>${escapeText(item.source)}</span>${date}</div>` +
						`<p class="release-title">${escapeText(item.title || item.link)}</p>` +
						titleFa +
						descHtml +
						analysisHtml +
						`<div class="release-actions">` +
						`${analyzeBtn}` +
						`<a class="release-link" href="${escapeText(item.link)}" target="_blank" rel="noopener noreferrer">مشاهده خبر اصلی ↗️</a>` +
						`</div>` +
						`</article>`
					);
				})
				.join('');
		}

		const sources = data.sources || [];
		sourcesGrid.innerHTML = sources
			.map(function (src) {
				let dotClass = 'dot-warn';
				let statusText = 'در انتظار اولین اسکن';
				if (src.initialized && src.failures === 0) {
					dotClass = 'dot-ok';
					statusText = `${src.type} · ${src.lastCount} آیتم`;
				} else if (src.failures > 0) {
					dotClass = 'dot-err';
					statusText = `${src.failures} خطا (${src.lastError || 'خطا'})`;
				}
				return (
					`<div class="source-card">` +
					`<div><div class="source-name">${escapeText(src.name)}</div>` +
					`<div class="source-sub">${escapeText(statusText)}</div></div>` +
					`<span class="dot ${dotClass}"></span>` +
					`</div>`
				);
			})
			.join('');
	}

	async function loadDashboard() {
		try {
			const data = await callEndpoint('getDashboard', {});
			renderDashboard(data);
		} catch (err) {
			showBanner(err.message, true);
			releasesList.innerHTML = `<p class="empty">${escapeText(err.message)}</p>`;
		}
	}

	scanBtn.addEventListener('click', async function () {
		scanBtn.disabled = true;
		scanBtn.textContent = '⏳ در حال اسکن...';
		try {
			const res = await callEndpoint('runScan', {});
			renderDashboard(res.dashboard);
			const announced = (res.summary && res.summary.announcedItems && res.summary.announcedItems.length) || 0;
			const baselined = (res.summary && res.summary.baselined) || 0;
			if (announced > 0) {
				showBanner(`✅ اسکن انجام شد: ${announced} مدل جدید ترجمه، تحلیل و منتشر شد.`, false);
			} else if (baselined > 0) {
				showBanner(`📌 خط پایه ${baselined} منبع ثبت شد. مدل‌های بعدی با ترجمه و تحلیل فارسی ارسال می‌شوند.`, false);
			} else {
				showBanner('✅ همه منابع بررسی شدند — مدل جدیدی نسبت به قبل منتشر نشده بود.', false);
			}
		} catch (err) {
			showBanner(err.message, true);
		} finally {
			scanBtn.disabled = false;
			scanBtn.textContent = '🔍 اسکن زنده منابع';
		}
	});

	subBtn.addEventListener('click', async function () {
		subBtn.disabled = true;
		try {
			const data = await callEndpoint('toggleSubscribe', { subscribed: !currentSubscribed });
			renderDashboard(data);
			showBanner(data.isSubscribed ? '🔔 اعلان‌ها برای شما فعال شد.' : '🔕 اعلان‌ها غیرفعال شد.', false);
		} catch (err) {
			showBanner(err.message, true);
		} finally {
			subBtn.disabled = false;
		}
	});

	customAnalyzeBtn.addEventListener('click', async function () {
		const text = (customText.value || '').trim();
		if (!text) {
			showBanner('لطفاً ابتدا یک تیتر یا متن انگلیسی وارد کنید.', true);
			return;
		}
		customAnalyzeBtn.disabled = true;
		customAnalyzeBtn.textContent = '⏳ در حال ترجمه و تحلیل...';
		try {
			const res = await callEndpoint('analyzeRelease', { text });
			const c = res.custom || {};
			customAnalysisResult.hidden = false;
			customAnalysisResult.textContent = [
				`🇮🇷 ترجمه فارسی: ${c.titleFa || text}`,
				c.descriptionFa ? `💬 خلاصه: ${c.descriptionFa}` : '',
				c.analysisFa ? `\n📊 تحلیل رادار:\n${c.analysisFa}` : '',
			]
				.filter(Boolean)
				.join('\n');
		} catch (err) {
			showBanner(err.message, true);
		} finally {
			customAnalyzeBtn.disabled = false;
			customAnalyzeBtn.textContent = '✨ ترجمه و تحلیل فارسی';
		}
	});

	addChannelBtn.addEventListener('click', async function () {
		const channel = (channelInput.value || '').trim();
		if (!channel) {
			showBanner('لطفاً یوزرنیم (@channel) یا شناسه کانال را وارد کنید.', true);
			return;
		}
		addChannelBtn.disabled = true;
		addChannelBtn.textContent = '⏳ در حال بررسی...';
		try {
			const res = await callEndpoint('manageChannel', { action: 'add', channel });
			channelInput.value = '';
			renderDashboard(res.dashboard);
			showBanner(`✅ کانال ${res.added.label} متصل شد و پیام تست ارسال گردید.`, false);
		} catch (err) {
			showBanner(err.message, true);
		} finally {
			addChannelBtn.disabled = false;
			addChannelBtn.textContent = 'اتصال و تست';
		}
	});

	channelsList.addEventListener('click', async function (event) {
		const btn = event.target.closest('[data-remove-channel]');
		if (!btn) return;
		const channel = btn.getAttribute('data-remove-channel');
		btn.disabled = true;
		try {
			const res = await callEndpoint('manageChannel', { action: 'remove', channel });
			renderDashboard(res.dashboard);
			showBanner('🔕 اتصال کانال حذف شد.', false);
		} catch (err) {
			showBanner(err.message, true);
			btn.disabled = false;
		}
	});

	releasesList.addEventListener('click', async function (event) {
		const btn = event.target.closest('[data-analyze-id]');
		if (!btn) return;
		const id = Number(btn.getAttribute('data-analyze-id'));
		btn.disabled = true;
		btn.textContent = '⏳ در حال تحلیل...';
		try {
			const res = await callEndpoint('analyzeRelease', { id });
			if (res.item && latestDashboard && Array.isArray(latestDashboard.releases)) {
				latestDashboard.releases = latestDashboard.releases.map(function (r) {
					return Number(r.id) === id ? res.item : r;
				});
				renderDashboard(latestDashboard);
			}
		} catch (err) {
			showBanner(err.message, true);
			btn.disabled = false;
			btn.textContent = '🧠 ترجمه و تحلیل فارسی';
		}
	});

	loadDashboard();
})();
