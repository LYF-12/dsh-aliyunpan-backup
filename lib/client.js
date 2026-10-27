window.__ModuleLoader__.load({
	id: "dsh-aliyunpan-backup",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var jsxRuntime = require("react/jsx-runtime");
		var jsx = jsxRuntime.jsx;
		var jsxs = jsxRuntime.jsxs;
		var Fragment = react.Fragment;

		var PKG = "dsh-aliyunpan-backup";
		var BASE = "/api/" + PKG;

		function warn(step, error) {
			try {
				console.warn("[dsh-aliyunpan-backup] " + step + " 失败，该界面未挂载。", error);
			} catch {}
			return function () {};
		}

		function fmtBytes(n) {
			if (!n) return "-";
			var mb = n / 1048576;
			return mb >= 1 ? mb.toFixed(2) + " MB" : (n / 1024).toFixed(1) + " KB";
		}

		function fmtTime(iso) {
			if (!iso) return "-";
			try {
				return new Date(iso).toLocaleString();
			} catch {
				return iso;
			}
		}

		/** 状态轮询：解码任务在跑时 1.5s，其余 15s。 */
		function useStatus(pollMs) {
			var state = react.useState(null);
			var status = state[0];
			var setStatus = state[1];
			var errState = react.useState("");
			var error = errState[0];
			var setError = errState[1];
			var load = react.useCallback(function () {
				return fetch(BASE + "/status", { headers: { accept: "application/json" } })
					.then(function (res) {
						return res.json().then(function (body) {
							if (!res.ok) throw new Error(body && body.error ? body.error : "HTTP " + res.status);
							return body;
						});
					})
					.then(function (body) {
						setStatus(body);
						setError("");
						return body;
					})
					.catch(function (reason) {
						setError(String((reason && reason.message) || reason));
						return null;
					});
			}, []);
			react.useEffect(function () {
				var stopped = false;
				var timer;
				var tick = function (delay) {
					timer = setTimeout(function () {
						load().then(function (body) {
							if (stopped) return;
							var running = body && body.state && body.state.running;
							tick(running ? pollMs : 15000);
						});
					}, delay);
				};
				tick(60);
				return function () {
					stopped = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [load, pollMs]);
			return { status: status, error: error, reload: load };
		}

		var styles = {
			section: {
				display: "grid",
				gap: "10px",
				padding: "14px 16px",
				border: "1px solid var(--dsh-border, rgba(127,127,127,.22))",
				borderRadius: "10px",
				background: "var(--dsh-surface, transparent)",
			},
			head: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			title: { fontSize: "13px", fontWeight: 600, margin: 0 },
			badge: { fontSize: "11px", padding: "1px 8px", borderRadius: "999px", border: "1px solid currentColor", opacity: 0.85 },
			row: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
			btn: { fontSize: "12px", padding: "5px 11px", borderRadius: "7px", cursor: "pointer", border: "1px solid var(--dsh-border, rgba(127,127,127,.35))", background: "transparent", color: "inherit" },
			btnPrimary: { fontSize: "12px", padding: "5px 11px", borderRadius: "7px", cursor: "pointer", border: "1px solid transparent", background: "var(--dsh-accent, #2f6feb)", color: "#fff" },
			frame: { width: "100%", height: "680px", border: "1px solid var(--dsh-border, rgba(127,127,127,.28))", borderRadius: "10px", background: "#fff" },
			muted: { fontSize: "12px", opacity: 0.66, lineHeight: 1.5 },
			error: { fontSize: "12px", color: "#d4380d" },
		};

		function SyncSectionInner() {
			var status = useStatus(1500);
			var data = status.status;
			var running = Boolean(data && data.state && data.state.running);
			var job = data && data.state ? data.state.job : null;
			var sync = (data && data.sync) || {};
			var view = (data && data.view) || {};
			var packages = (data && (data.packages || data.snapshots)) || [];
			var [busy, setBusy] = react.useState("");
			var [hint, setHint] = react.useState("");
			// 配置页：宿主里 target=_blank 常被弹窗策略拦掉，改成卡片内嵌 + 复制地址兜底。
			var [showUi, setShowUi] = react.useState(false);
			var uiUrl = (typeof location !== "undefined" && location.origin ? location.origin : "") + BASE + "/ui";
			var copyUiUrl = function () {
				var done = function () { setHint("配置页地址已复制：" + uiUrl); };
				var fail = function () { setHint("配置页地址（复制到浏览器打开）：" + uiUrl); };
				try {
					if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(uiUrl).then(done).catch(fail);
					else fail();
				} catch (error) { fail(); }
			};

			var call = react.useCallback(function (path, body) {
				setBusy(path);
				setHint("");
				return fetch(BASE + path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body || {}),
				})
					.then(function (res) {
						return res.json().then(function (payload) {
							if (!res.ok || payload.ok === false) throw new Error((payload && payload.error) || "HTTP " + res.status);
							return payload;
						});
					})
					.then(function (payload) {
						setHint("已提交…");
						return status.reload().then(function () { return payload; });
					})
					.catch(function (reason) {
						setHint(String((reason && reason.message) || reason));
						return null;
					})
					.then(function (payload) {
						setBusy("");
						return payload;
					});
			}, [status]);

			var syncJob = sync.last;
			var badgeText = running ? "解码中" : job ? (job.phase === "done" ? "上次成功" : job.phase === "failed" ? "上次失败" : "空闲") : "尚未运行";
			var badgeColor = running ? "#d48806" : job && job.phase === "done" ? "#157f3c" : job && job.phase === "failed" ? "#b42318" : "inherit";
			var latest = packages.length ? packages[0] : null;

			return jsxs("section", {
				style: styles.section,
				children: [
					jsxs("div", {
						style: styles.head,
						children: [
							jsx("h4", { style: styles.title, children: "阿里云盘同步" }),
							jsx("span", { style: Object.assign({}, styles.badge, { color: badgeColor }), children: badgeText }),
							syncJob
								? jsx("span", { style: styles.muted, children: "上次同步 " + fmtTime(syncJob.at) + " · files=" + syncJob.files })
								: null,
						],
					}),
					jsx("div", {
						style: styles.muted,
						children: "把 " + (view.dshHome || "~/.dsh") + " 里的会话 / 附件 / 工作区索引逐文件镜像到 " +
							(sync.dir || "/DeepSeek Harness/DSH-Sync") + "（" + (sync.mode === "download" ? "从机拉取" : "主机上传") +
							"）。同步不打包不加密；手里有旧的加密包也可以在配置页里解码。",
					}),
					jsxs("div", {
						style: styles.row,
						children: [
							jsx("button", {
								style: styles.btnPrimary,
								disabled: busy !== "",
								onClick: function () { call("/sync/run", { mode: "upload" }); },
								children: busy === "/sync/run" ? "提交中…" : "同步上传",
							}),
							jsx("button", {
								style: styles.btn,
								disabled: busy !== "",
								onClick: function () { call("/sync/run", { mode: "download" }); },
								children: "从机拉取",
							}),
							jsx("button", { style: styles.btn, onClick: function () { status.reload(); }, children: "刷新" }),
							jsx("button", {
								style: styles.btn,
								onClick: function () { setShowUi(function (v) { return !v; }); },
								children: showUi ? "收起配置页" : "打开完整配置页",
							}),
							jsx("button", { style: styles.btn, onClick: copyUiUrl, children: "复制配置页地址" }),
						],
					}),
					showUi
						? jsx("iframe", {
								title: "dsh-aliyunpan-backup 配置页",
								src: BASE + "/ui",
								style: styles.frame,
							})
						: null,
					status.error ? jsx("div", { style: styles.error, children: status.error }) : null,
					hint ? jsx("div", { style: styles.muted, children: hint }) : null,
					jsx("div", {
						style: styles.muted,
						children: "暂存目录 " + (view.stagingDir || "-") + " · 可解码的包 " + packages.length + " 个" +
							(latest ? "（最新 " + latest.id + " · " + fmtBytes(latest.bytes) + "）" : "") +
							" · aliyunpan " + (view.aliyunpanExe ? "已找到" : "未找到"),
					}),
				],
			});
		}

		// 同一组件挂两处：`plugins.bundle.config`（设置→插件里本插件自己的配置卡片，
		// 按 bundle 的包名作 key，渲染时 props 由 inject() 提供、没有 subject）；
		// `plugins.detail.section`（插件详情页附加区，props 带 subject）。
		// 有 subject 时就只认本包，避免出现在别的插件页上。
		function SyncSection(props) {
			var subject = props ? props.subject : void 0;
			if (subject && (subject.kind !== "bundle" || !subject.pkg || subject.pkg.name !== PKG)) return null;
			return jsx(SyncSectionInner, {});
		}

		var inject = [];

		function registerInto(slots, name, options) {
			if (typeof slots.inject !== "function" || typeof slots.register !== "function") return;
			try {
				slots.inject(name, function () {
					try {
						return slots.register(Object.assign({ name: name }, options), SyncSection);
					} catch (error) {
						return warn(name, error);
					}
				});
			} catch (error) {
				// 宿主没有这个席位：静默降级，绝不让本插件的 client 入口失败。
				warn(name, error);
			}
		}

		function apply(ctx) {
			ctx.inject(["slots"], function (slotsCtx) {
				var slots = slotsCtx && slotsCtx.slots;
				if (!slots) return;
				// 官方 keyed 席位：设置 → 插件 → dsh-aliyunpan-backup 那一行的配置卡。
				registerInto(slots, "plugins.bundle.config", { key: PKG });
				// 详情页附加区（老席位，宿主没有 keyed 席位时仍能看到入口）。
				registerInto(slots, "plugins.detail.section", { id: "aliyunpan-backup", order: 40 });
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
