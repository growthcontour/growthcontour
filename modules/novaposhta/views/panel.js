/* Нова пошта — панель відправлення в картці замовлення (модуль novaposhta). Підключається хуком displayOrderShipping. */
(function () {
	"use strict";
	const root = document.getElementById("np-panel");
	if (!root || root.dataset.ready) return;
	root.dataset.ready = "1";

	const OID = Number(root.dataset.order);
	const EDIT = root.dataset.edit === "1";
	const SETTINGS = root.dataset.settings === "1";
	let L = {};
	try {
		L = JSON.parse(root.dataset.l || "{}");
	} catch (e) {}
	const B = "/api/module/novaposhta";
	const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
	const t = (k) => (L[k] !== undefined ? L[k] : k);

	async function api(path, body) {
		const res = await fetch(B + path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body || {}) });
		let j = {};
		try {
			j = await res.json();
		} catch (e) {}
		if (!res.ok || !j.ok) throw new Error(j.error || t("error"));
		return j;
	}
	function toast(msg, ok) {
		if (window.Notyf) {
			if (!window.__npNotyf) window.__npNotyf = new Notyf({ duration: 4000, position: { x: "right", y: "top" } });
			return ok ? window.__npNotyf.success(msg) : window.__npNotyf.error(msg);
		}
		if (!ok) alert(msg);
	}

	let state = null;

	async function load() {
		root.innerHTML = '<div class="p-3 text-secondary small"><span class="spinner-border spinner-border-sm"></span></div>';
		try {
			state = await api(`/order/${OID}/`);
		} catch (e) {
			root.innerHTML = `<div class="p-3 text-danger small">${esc(e.message)}</div>`;
			return;
		}
		render();
	}

	function field(label, html, col) {
		return `<div class="${col || "col-md-6"}"><label class="form-label small mb-1">${esc(label)}</label>${html}</div>`;
	}
	const dis = EDIT ? "" : " disabled";

	function render() {
		if (!state.has_accounts) {
			root.innerHTML = `<div class="p-3 small"><i class="fa-solid fa-truck-fast me-1"></i>${esc(t("no_accounts"))} ${SETTINGS ? `<a href="/modules/novaposhta/">${esc(t("setup"))}</a>` : ""}</div>`;
			return;
		}
		if (!state.shipments.length) {
			root.innerHTML = `<div class="p-3 small text-secondary">${esc(t("no_address"))}</div>`;
			return;
		}
		root.innerHTML = state.shipments.map(card).join("");
		state.shipments.forEach(bind);
	}

	function card(s) {
		const d = s.data || {};
		const r = d.recipient || {};
		const a = d.address || {};
		const badge = { review: "text-bg-warning", draft: "text-bg-success", created: "text-bg-primary", in_transit: "text-bg-info", delivered: "text-bg-success", returned: "text-bg-dark" }[s.status] || "text-bg-secondary";
		const ttn = d.ttn || null;
		const tr = d.track || null;
		const pdf = (fmt) => `${B}/order/${OID}/${s.id}/print/?format=${fmt}`;
		const review = (d.review || []).map((c) => `<li>${esc(t("r_" + c))}</li>`).join("");
		const found = (d.found_by || []).map((c) => t("f_" + c)).join(", ");
		const accOpts = `<option value="">${esc(t("choose"))}</option>` + state.accounts.map((x) => `<option value="${x.id}"${x.id === d.account_id ? " selected" : ""}>${esc(x.name)}</option>`).join("");
		const svc = ["warehouse", "postomat", "address"].map((k) => `<option value="${k}"${d.service === k ? " selected" : ""}>${esc(t("s_" + k))}</option>`).join("");
		const calc = d.calc ? `<div class="small mt-2">${esc(t("cost"))}: <b>${Number(d.calc.cost).toFixed(2)}</b>${d.calc.cost_redelivery ? ` + ${Number(d.calc.cost_redelivery).toFixed(2)} (${esc(t("cod_fee"))})` : ""}</div>` : "";
		return `<form class="p-3 np-ship" data-id="${s.id}" autocomplete="off">
			<div class="d-flex align-items-center mb-2">
				<b class="me-2"><i class="fa-solid fa-truck-fast me-1"></i>${esc(t("title"))}</b>
				<span class="badge rounded-0 ${badge}">${esc(t("st_" + s.status))}</span>
				${s.tracking_number ? `<span class="ms-2">${esc(t("ttn"))} <b>${esc(s.tracking_number)}</b></span>` : ""}
			</div>
			${s.tracking_number ? `<div class="border p-2 mb-2 small">
				${ttn && ttn.estimated ? `<div>${esc(t("estimated"))}: <b>${esc(ttn.estimated)}</b></div>` : ""}
				${ttn && ttn.cost ? `<div>${esc(t("cost"))}: <b>${Number(ttn.cost).toFixed(2)}</b></div>` : ""}
				${tr ? `<div>${esc(t("track_status"))}: <b>${esc(tr.text)}</b> <span class="text-secondary">(${esc(new Date(tr.at).toLocaleString())})</span></div>` : ""}
				<div class="d-flex flex-wrap gap-2 mt-2">
					<a class="btn btn-sm btn-outline-primary rounded-0" href="${pdf("a4")}" target="_blank"><i class="fa-solid fa-print"></i> ${esc(t("print_a4"))}</a>
					<a class="btn btn-sm btn-outline-primary rounded-0" href="${pdf("100")}" target="_blank"><i class="fa-solid fa-tag"></i> ${esc(t("print_100"))}</a>
					<button type="button" class="btn btn-sm btn-outline-secondary rounded-0" data-act="track"><i class="fa-solid fa-route"></i> ${esc(t("track"))}</button>
					<a class="btn btn-sm btn-outline-secondary rounded-0" href="https://novaposhta.ua/tracking/?cargo_number=${encodeURIComponent(s.tracking_number)}" target="_blank" rel="noopener"><i class="fa-solid fa-arrow-up-right-from-square"></i> novaposhta.ua</a>
					${EDIT && (s.status === "created" || s.status === "review" || s.status === "draft") ? `<button type="button" class="btn btn-sm btn-outline-danger rounded-0 ms-auto" data-act="ttn_delete"><i class="fa-solid fa-trash"></i> ${esc(t("ttn_delete"))}</button>` : ""}
				</div>
			</div>` : ""}
			${review ? `<ul class="small text-warning-emphasis mb-2 ps-3">${review}</ul>` : ""}
			<div class="row g-2">
				${field(t("account"), `<select class="form-select form-select-sm rounded-0" name="account_id"${dis}>${accOpts}</select>`)}
				${field(t("service"), `<select class="form-select form-select-sm rounded-0" name="service"${dis}>${svc}</select>`)}
				${field(t("city"), `<div class="position-relative"><input class="form-control form-control-sm rounded-0" name="city" value="${esc(d.city ? d.city.name : "")}" placeholder="${esc(t("search_city"))}"${dis} /><input type="hidden" name="city_ref" value="${esc(d.city ? d.city.ref : "")}" /><div class="np-list list-group position-absolute w-100 shadow-sm d-none" style="z-index:1060;max-height:240px;overflow:auto"></div></div>${d.city && d.city.area ? `<div class="form-text mt-0">${esc(d.city.area)}</div>` : ""}`, "col-12")}
				<div class="col-12 np-point${d.service === "address" ? " d-none" : ""}">
					<label class="form-label small mb-1">${esc(t("point"))}</label>
					<div class="input-group input-group-sm">
						<input class="form-control rounded-0" name="point_q" placeholder="${esc(t("search_point"))}" style="max-width:140px"${dis} />
						<select class="form-select rounded-0" name="point_ref"${dis}><option value="${esc(d.point ? d.point.ref : "")}">${esc(d.point ? d.point.name : t("choose"))}</option></select>
					</div>
				</div>
				<div class="col-12 np-addr${d.service === "address" ? "" : " d-none"}"><div class="row g-2">
					${field(t("street"), `<input class="form-control form-control-sm rounded-0" name="street" value="${esc(a.street || "")}"${dis} />`, "col-md-6")}
					${field(t("building"), `<input class="form-control form-control-sm rounded-0" name="building" value="${esc(a.building || "")}"${dis} />`, "col-md-3")}
					${field(t("flat"), `<input class="form-control form-control-sm rounded-0" name="flat" value="${esc(a.flat || "")}"${dis} />`, "col-md-3")}
				</div></div>
				<div class="col-12"><div class="small fw-semibold mt-1">${esc(t("recipient"))}</div></div>
				${field(t("lastname"), `<input class="form-control form-control-sm rounded-0" name="lastname" value="${esc(r.lastname || "")}"${dis} />`, "col-md-4")}
				${field(t("firstname"), `<input class="form-control form-control-sm rounded-0" name="firstname" value="${esc(r.firstname || "")}"${dis} />`, "col-md-4")}
				${field(t("middlename"), `<input class="form-control form-control-sm rounded-0" name="middlename" value="${esc(r.middlename || "")}"${dis} />`, "col-md-4")}
				${field(t("phone"), `<input class="form-control form-control-sm rounded-0" name="phone" value="${esc(r.phone || "")}" placeholder="380XXXXXXXXX"${dis} />`, "col-md-4")}
				${field(t("weight"), `<input type="number" step="0.1" min="0.1" class="form-control form-control-sm rounded-0" name="weight" value="${s.weight === null ? "" : s.weight}"${dis} />`, "col-md-2")}
				${field(t("seats"), `<input type="number" min="1" class="form-control form-control-sm rounded-0" name="seats" value="${d.seats || 1}"${dis} />`, "col-md-2")}
				${field(t("payer"), `<select class="form-select form-select-sm rounded-0" name="payer"${dis}>${["Recipient", "Sender"].map((k) => `<option value="${k}"${d.payer === k ? " selected" : ""}>${esc(t("payer_" + k))}</option>`).join("")}</select>`, "col-md-4")}
				${field(t("declared"), `<input type="number" step="0.01" min="0" class="form-control form-control-sm rounded-0" name="declared" value="${d.declared || 0}"${dis} />`, "col-md-4")}
				${field(t("cod"), `<input type="number" step="0.01" min="0" class="form-control form-control-sm rounded-0" name="cod" value="${d.cod || 0}"${dis} />`, "col-md-4")}
				${field(t("description"), `<input class="form-control form-control-sm rounded-0" name="description" value="${esc(d.description || "")}" maxlength="100"${dis} />`, "col-md-4")}
			</div>
			${found ? `<div class="form-text">${esc(t("found"))}: ${esc(found)}</div>` : ""}
			${calc}
			${EDIT && !s.tracking_number ? `<div class="d-flex flex-wrap gap-2 mt-2">
				<button type="submit" class="btn btn-sm btn-primary rounded-0"><i class="fa-solid fa-floppy-disk"></i> ${esc(t("save"))}</button>
				<button type="button" class="btn btn-sm btn-outline-secondary rounded-0" data-act="calc"><i class="fa-solid fa-calculator"></i> ${esc(t("calc"))}</button>
				<button type="button" class="btn btn-sm btn-success rounded-0" data-act="ttn"${s.status === "draft" ? "" : ` disabled title="${esc(t("ttn_not_ready"))}"`}><i class="fa-solid fa-file-circle-plus"></i> ${esc(t("ttn_create"))}</button>
				<button type="button" class="btn btn-sm btn-outline-secondary rounded-0 ms-auto" data-act="rebuild"><i class="fa-solid fa-rotate-left"></i> ${esc(t("rebuild"))}</button>
			</div>
			${s.status === "draft" ? `<div class="form-text">${esc(t("ttn_save_first"))}</div>` : ""}` : ""}
		</form>`;
	}

	function bind(s) {
		const f = root.querySelector(`.np-ship[data-id="${s.id}"]`);
		if (!f) return;
		// ТТН: статус — для всіх, хто бачить замовлення; видалення — з правом редагування
		f.addEventListener("click", async (e) => {
			const b = e.target.closest('[data-act="track"],[data-act="ttn_delete"]');
			if (!b) return;
			b.disabled = true;
			try {
				if (b.dataset.act === "track") await api(`/order/${OID}/${s.id}/track/`);
				else if (confirm(t("confirm_ttn_delete"))) await api(`/order/${OID}/${s.id}/ttn/delete/`);
				load();
			} catch (err) {
				b.disabled = false;
				toast(err.message);
			}
		});
		if (!EDIT || s.tracking_number) return;
		const d = s.data || {};
		const typeOf = () => (f.service.value === "postomat" ? "postomat" : f.service.value === "warehouse" ? "warehouse" : "");

		f.service.addEventListener("change", () => {
			f.querySelector(".np-point").classList.toggle("d-none", f.service.value === "address");
			f.querySelector(".np-addr").classList.toggle("d-none", f.service.value !== "address");
			loadPoints();
		});

		// Місто: пошук по довіднику
		const list = f.querySelector(".np-list");
		let timer = null;
		f.city.addEventListener("input", () => {
			f.city_ref.value = "";
			clearTimeout(timer);
			timer = setTimeout(async () => {
				const q = f.city.value.trim();
				if (q.length < 2) return list.classList.add("d-none");
				const r = await api("/cities/", { q }).catch(() => ({ rows: [] }));
				list.innerHTML =
					r.rows.map((c) => `<button type="button" class="list-group-item list-group-item-action py-1 small" data-ref="${c.ref}" data-name="${esc(c.name)}">${esc(c.name)} <span class="text-secondary">${esc(c.area || "")}${c.type ? ", " + esc(c.type) : ""}</span></button>`).join("") ||
					`<div class="list-group-item small text-secondary">${esc(t("nothing"))}</div>`;
				list.classList.remove("d-none");
			}, 300);
		});
		list.addEventListener("click", (e) => {
			const b = e.target.closest("button[data-ref]");
			if (!b) return;
			f.city.value = b.dataset.name;
			f.city_ref.value = b.dataset.ref;
			list.classList.add("d-none");
			f.point_ref.innerHTML = `<option value="">${esc(t("choose"))}</option>`;
			loadPoints();
		});
		document.addEventListener("click", (e) => {
			if (!list.contains(e.target) && e.target !== f.city) list.classList.add("d-none");
		});

		// Відділення / поштомати міста: номер або адреса
		async function loadPoints() {
			const cityRef = f.city_ref.value;
			if (!cityRef || f.service.value === "address") return;
			const cur = f.point_ref.value;
			const r = await api("/warehouses/", { city_ref: cityRef, q: f.point_q.value.trim(), type: typeOf() }).catch(() => ({ rows: [] }));
			f.point_ref.innerHTML =
				`<option value="">${esc(r.rows.length ? t("choose") : t("nothing"))}</option>` +
				r.rows.map((w) => `<option value="${w.ref}"${w.ref === cur ? " selected" : ""}>${esc(w.name)}</option>`).join("");
		}
		let ptimer = null;
		f.point_q.addEventListener("input", () => {
			clearTimeout(ptimer);
			ptimer = setTimeout(loadPoints, 300);
		});
		f.point_ref.addEventListener("focus", () => {
			if (f.point_ref.options.length <= 1) loadPoints();
		}, { once: true });

		f.addEventListener("submit", async (e) => {
			e.preventDefault();
			const body = {
				account_id: f.account_id.value ? Number(f.account_id.value) : null,
				service: f.service.value,
				city_ref: f.city_ref.value || null,
				recipient: { lastname: f.lastname.value, firstname: f.firstname.value, middlename: f.middlename.value, phone: f.phone.value },
				weight: f.weight.value,
				seats: f.seats.value,
				declared: f.declared.value,
				cod: f.cod.value,
				description: f.description.value,
				payer: f.payer.value,
			};
			if (f.service.value === "address") body.address = { street: f.street.value, building: f.building.value, flat: f.flat.value };
			else body.point_ref = f.point_ref.value || null;
			try {
				await api(`/order/${OID}/${s.id}/save/`, body);
				toast(t("saved"), true);
				load();
			} catch (err) {
				toast(err.message);
			}
		});
		f.addEventListener("click", async (e) => {
			const b = e.target.closest("[data-act]");
			if (!b) return;
			try {
				if (b.dataset.act === "calc") {
					await api(`/order/${OID}/${s.id}/calc/`);
					load();
				} else if (b.dataset.act === "rebuild" && confirm(t("confirm_rebuild"))) {
					await api(`/order/${OID}/${s.id}/rebuild/`);
					load();
				} else if (b.dataset.act === "ttn" && confirm(t("confirm_ttn"))) {
					b.disabled = true;
					const r = await api(`/order/${OID}/${s.id}/ttn/`);
					toast(t("ttn_created").replace("%s", r.shipment.tracking_number), true);
					load();
				}
			} catch (err) {
				toast(err.message);
			}
		});
	}

	load();
})();
