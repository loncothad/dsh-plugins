/** Scoped settings and conversation surfaces, built from native DSH tokens. */
export const configurationTheme = `
.dsh-plugin-settings { width:100%; min-width:0; max-width:960px; box-sizing:border-box; color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; }
.dsh-plugin-settings * { box-sizing:border-box; }
.dsh-plugin-settings .config-overview { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:0 0 18px; }
.dsh-plugin-settings .config-navigation { display:flex; flex-wrap:wrap; gap:4px; min-width:0; }
.dsh-plugin-settings .config-navigation button { color:var(--dsw-alias-label-secondary); }
.dsh-plugin-settings .config-edit-state { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.dsh-plugin-settings .config-badge { display:inline-flex; align-items:center; flex:none; gap:6px; padding:3px 8px; border-radius:var(--dsw-radius-sm); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:11px; font-weight:500; }
.dsh-plugin-settings .config-badge-pending { color:var(--dsw-alias-state-business-primary); }
.dsh-plugin-settings .config-section { min-width:0; margin:0; padding:20px 0; border:0; border-top:0.5px solid var(--dsw-alias-border-l2); border-radius:0; background:transparent; scroll-margin-top:16px; }
.dsh-plugin-settings .config-section-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.dsh-plugin-settings h3,.dsh-plugin-settings h4 { margin:0 0 12px; font-size:14px; font-weight:600; line-height:1.5; }
.dsh-plugin-settings .config-section-header h3 { margin:0; }
.dsh-plugin-settings p { margin:6px 0 12px; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-tertiary); overflow-wrap:anywhere; }
.dsh-plugin-settings .config-section-description { margin:6px 0 16px; }
.dsh-plugin-settings .config-field { padding:16px 0; min-width:0; }
.dsh-plugin-settings .config-field-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); align-items:start; gap:12px 28px; padding:16px 0; min-width:0; }
.dsh-plugin-settings .config-field + .config-field { border-top:0.5px solid var(--dsw-alias-border-l2); }
.dsh-plugin-settings .config-field-copy,.dsh-plugin-settings .config-field-control { min-width:0; }
.dsh-plugin-settings .config-route-picker { display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:12px; }
.dsh-plugin-settings fieldset label { display:block; }
.dsh-plugin-settings fieldset select { display:block;margin-top:6px; }
.dsh-plugin-settings .config-editor-row { margin:12px 0;padding:12px 0;border-bottom:0.5px solid var(--dsw-alias-border-l2); }
.dsh-plugin-settings .config-field-copy p { margin-bottom:0; }
.dsh-plugin-settings .config-field-wide { grid-template-columns:minmax(0,1fr); }
.dsh-plugin-settings .config-field-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:6px; }
.dsh-plugin-settings .config-field-head label { font-size:13px; font-weight:500; min-width:0; }
.dsh-plugin-settings .config-field-head button { flex:none; padding:0 4px; height:auto; min-height:24px; color:var(--dsw-alias-label-secondary); font-size:11px; }
.dsh-plugin-settings .config-field-head button:hover { color:var(--dsw-alias-label-primary); }
.dsh-plugin-settings select,.dsh-plugin-settings textarea { width:100%; max-width:100%; min-width:0; padding:8px 12px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:inherit; }
.dsh-plugin-settings textarea { resize:vertical; line-height:1.6; }
.dsh-plugin-settings .config-input { display:flex; width:100%; min-width:0; }
.dsh-plugin-settings input { font-size:13px; }
.dsh-plugin-settings button { max-width:100%; }
.dsh-plugin-settings select:focus-visible,.dsh-plugin-settings textarea:focus-visible,.dsh-plugin-settings .config-section:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:2px; }
.dsh-plugin-settings [role=alert] { color:var(--dsw-alias-state-error-primary); }
.dsh-plugin-settings small { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.dsh-plugin-settings table { width:100%; border-collapse:collapse; font-size:12px; }
.dsh-plugin-settings caption { text-align:left; padding:8px 0; color:var(--dsw-alias-label-tertiary); }
.dsh-plugin-settings th { font-weight:500; color:var(--dsw-alias-label-secondary); }
.dsh-plugin-settings th,.dsh-plugin-settings td { border-bottom:0.5px solid var(--dsw-alias-border-l2); padding:12px 10px; vertical-align:top; }
.dsh-plugin-settings a { color:var(--dsw-alias-state-business-primary); text-underline-offset:3px; }
.dsh-plugin-settings .config-auth-methods,.dsh-plugin-settings .config-actions { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.dsh-plugin-settings .config-accounts { margin-top:16px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); padding:14px; background:var(--dsw-alias-bg-layer-2); }
.dsh-plugin-settings .config-account { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; padding:8px 0; }
.dsh-plugin-settings .config-subscription { flex:1 0 100%; min-width:0; padding:8px 0; }
.dsh-plugin-settings .config-subscription button { margin:4px 8px 4px 0; }
 .dsh-plugin-settings .config-quota-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
.dsh-plugin-settings .config-quota-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr)); gap:12px; margin:12px 0; }
.dsh-plugin-settings .config-quota-window { padding:14px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-base); min-width:0; }
.dsh-plugin-settings .config-quota-window progress { display:block; width:100%; height:6px; margin:12px 0; accent-color:var(--dsw-alias-label-link,#406cff); }
.dsh-plugin-settings .config-quota-window p { margin:6px 0; }
.dsh-plugin-settings .config-quota-window small { display:block; }
.dsh-plugin-settings .config-quota-renewal { color:var(--dsw-alias-label-primary); }
.dsh-plugin-settings .config-quota-resets { margin:14px 0; }
.dsh-plugin-settings .config-quota-resets h5 { font-size:13px; margin:0; }
.dsh-plugin-settings .config-reset-row { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:10px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
.dsh-plugin-settings .config-reset-row small { display:block; margin-top:3px; }
.dsh-plugin-settings .config-quota-checked { display:block; margin-top:12px; }
.dsh-plugin-settings .config-glob-disclosure { margin:8px 0; padding:10px 12px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-layer-2); }
.dsh-plugin-settings .config-glob-disclosure summary { cursor:pointer; font-size:13px; color:var(--dsw-alias-label-secondary); }
.dsh-plugin-settings .config-glob-disclosure pre { max-height:260px; overflow:auto; margin-top:10px; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.dsh-plugin-settings .config-account + .config-account { border-top:0.5px solid var(--dsw-alias-border-l2); }
.dsh-plugin-settings .config-accounts h4 { margin-bottom:4px; }
.dsh-plugin-settings .config-note { padding:12px 14px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-bg-layer-2); }
.dsh-plugin-settings .config-status { margin:12px 0 0; }
.dsh-plugin-settings .config-model { margin:12px 0; padding:16px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-layer-2); }
.dsh-plugin-settings.config-summary-card { margin:0 0 12px; padding:16px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); background:var(--dsw-alias-bg-base); }
.config-summary-card header > .config-badge { margin-left:8px; }
.config-summary-card details { margin:12px 0; padding:12px; background:var(--dsw-alias-bg-layer-2); border-radius:var(--dsw-radius-md); }
.config-summary-card summary { font-weight:500; }
.dsh-plugin-settings dl { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.5fr); gap:8px 12px; }
.dsh-plugin-settings dt,.dsh-plugin-settings dd { min-width:0; overflow-wrap:anywhere; }
.dsh-plugin-settings dd { margin:0; }
@media(max-width:900px) { .dsh-plugin-settings .config-field-row { grid-template-columns:minmax(0,1fr); gap:8px; } }
@media(max-width:540px) { .dsh-plugin-settings .config-route-picker { grid-template-columns:minmax(0,1fr); } }
@media(max-width:540px) { .dsh-plugin-settings .config-section { padding:16px 0; } .dsh-plugin-settings .config-field-head { flex-wrap:wrap; gap:4px 12px; } .dsh-plugin-settings .config-auth-methods > button { width:100%; justify-content:center; white-space:normal; height:auto; min-height:32px; } .dsh-plugin-settings .config-navigation button { height:auto; min-height:28px; text-align:left; white-space:normal; } }
`
