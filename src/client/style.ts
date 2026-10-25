/** Computer-side panel: two-column dashboard in wide containers, reflowed rather than shrunk on touch screens. */
export const CSS = `
.dsrc{--rc-ink:var(--dsw-alias-label-primary,#282b3a);--rc-muted:var(--dsw-alias-label-secondary,#6c7080);--rc-line:var(--dsw-alias-border-l2,#dfe2ea);--rc-paper:var(--dsw-alias-background-primary,#fff);--rc-fill:color-mix(in srgb,var(--rc-ink) 5%,transparent);--rc-accent:var(--cl-accent,#D97757);--rc-accent-ink:var(--cl-accent-ink,#fff);--rc-indigo:#4c5cc5;--rc-teal:#157d75;--rc-violet:#7050c8;--rc-warm:#a75d19;--rc-slate:#5d6b7a;--rc-danger:var(--dsw-alias-color-error,#B34337);--rc-success:var(--dsw-alias-color-success,#177654);--rc-warning:var(--rc-warm);--rc-indigo-soft:color-mix(in srgb,var(--rc-indigo) 8%,var(--rc-paper));--rc-teal-soft:color-mix(in srgb,var(--rc-teal) 6%,var(--rc-paper));--rc-violet-soft:color-mix(in srgb,var(--rc-violet) 8%,var(--rc-paper));--rc-warm-soft:color-mix(in srgb,var(--rc-warm) 7%,var(--rc-paper));container-type:inline-size;color:var(--rc-ink);font-family:inherit;font-size:13px;line-height:1.55;width:100%;min-width:0;max-width:960px;margin:0 auto}
.dsrc *{box-sizing:border-box}
.dsrc h2,.dsrc h3,.dsrc p{margin:0}
.dsrc h2{font-size:20px;line-height:1.4;font-weight:650;letter-spacing:-.015em}
.dsrc h3{font-size:14px;line-height:1.5;font-weight:650}
.dsrc button,.dsrc input,.dsrc textarea{font:inherit;color:inherit}
.dsrc button{cursor:pointer}
.dsrc button:disabled{cursor:not-allowed;opacity:.45}
.dsrc button:focus-visible,.dsrc input:focus-visible,.dsrc textarea:focus-visible,.dsrc summary:focus-visible,.dsrc a:focus-visible{outline:2px solid var(--rc-accent);outline-offset:3px}
.dsrc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;min-width:0;margin-bottom:4px}
.dsrc-sub{font-size:12px;color:var(--rc-muted);margin-top:3px!important}
.dsrc-badge{display:inline-flex;align-items:center;gap:7px;flex:none;border:1px solid var(--rc-line);border-radius:999px;background:var(--rc-fill);padding:3px 10px;color:var(--rc-muted);font-size:12px;line-height:20px;white-space:nowrap}
.dsrc-dot{width:6px;height:6px;flex:none;background:currentColor;border-radius:50%}
.dsrc-badge[data-state=ready]{border-color:color-mix(in srgb,var(--rc-teal) 28%,transparent);background:color-mix(in srgb,var(--rc-teal) 9%,transparent);color:var(--rc-teal)}
.dsrc-badge[data-state=busy]{border-color:color-mix(in srgb,var(--rc-indigo) 26%,transparent);background:var(--rc-indigo-soft);color:var(--rc-indigo)}
.dsrc-badge[data-state=busy] .dsrc-dot{animation:dsrc-pulse 1.4s ease-in-out infinite}
.dsrc-badge[data-state=blocked]{border-color:color-mix(in srgb,var(--rc-warm) 30%,transparent);background:var(--rc-warm-soft);color:var(--rc-warm)}
.dsrc-badge[data-state=error]{border-color:color-mix(in srgb,var(--rc-danger) 30%,transparent);background:color-mix(in srgb,var(--rc-danger) 8%,transparent);color:var(--rc-danger)}
.dsrc-surface{display:block;min-width:0;border:1px solid var(--rc-line);border-radius:13px;padding:15px;background:var(--rc-paper)}

.dsrc-layout{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:12px;align-items:start;margin-top:12px}
.dsrc-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.dsrc-col>.dsrc-surface{margin-top:0}
.dsrc-card-head{display:flex;align-items:center;gap:9px;min-width:0}
.dsrc-card-head h3{flex:none}
.dsrc-card-head .dsrc-tag,.dsrc-card-head .dsrc-count{flex:none}
.dsrc-spacer{flex:1;min-width:0}
.dsrc-card-icon{display:grid;place-items:center;width:27px;height:27px;flex:none;border-radius:8px;background:color-mix(in srgb,var(--tone) 11%,transparent);color:var(--tone)}
.dsrc-card-icon[data-tone=indigo]{--tone:var(--rc-indigo)}
.dsrc-card-icon[data-tone=teal]{--tone:var(--rc-teal)}
.dsrc-card-icon[data-tone=violet]{--tone:var(--rc-violet)}
.dsrc-card-icon[data-tone=warm]{--tone:var(--rc-warm)}
.dsrc-card-icon[data-tone=slate]{--tone:var(--rc-slate)}
.dsrc-card-icon svg{width:15px;height:15px}

.dsrc-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsrc-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--rc-violet-soft);color:var(--rc-violet);font-size:11px;font-variant-numeric:tabular-nums}
.dsrc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsrc-muted{color:var(--rc-muted);font-size:12px;overflow-wrap:anywhere}
.dsrc-note{color:var(--rc-muted);font-size:12px;line-height:1.6;margin-top:7px!important;overflow-wrap:anywhere}
.dsrc-field-label{display:block;color:var(--rc-muted);font-size:12px;font-weight:600;line-height:20px}
.dsrc-empty{padding:12px 0 0;color:var(--rc-muted)}
.dsrc-error{color:var(--rc-danger);background:color-mix(in srgb,var(--rc-danger) 8%,transparent);border-radius:8px;padding:7px 10px;margin-top:8px;overflow-wrap:anywhere}
.dsrc-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.dsrc-row>.dsrc-actions{flex-shrink:0}
.dsrc-button{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:5px 12px;border:1px solid var(--rc-line);border-radius:8px;background:transparent;font-size:13px;line-height:20px;white-space:nowrap;transition:background .14s,border-color .14s,box-shadow .14s}
.dsrc-button:hover:not(:disabled){background:var(--rc-fill);border-color:color-mix(in srgb,var(--rc-ink) 25%,var(--rc-line))}
.dsrc-primary{background:var(--rc-accent);border-color:var(--rc-accent);color:var(--rc-accent-ink)!important;font-weight:650;box-shadow:0 2px 5px color-mix(in srgb,var(--rc-accent) 20%,transparent)}
.dsrc-primary:hover:not(:disabled){background:var(--rc-accent);border-color:var(--rc-accent);filter:brightness(.94)}
.dsrc-danger{border-color:transparent;color:var(--rc-danger)!important;padding-right:8px;padding-left:8px}
.dsrc-danger:hover:not(:disabled){background:color-mix(in srgb,var(--rc-danger) 9%,transparent);border-color:transparent}
.dsrc-ghost{border-color:transparent;color:var(--rc-muted)!important;padding-right:8px;padding-left:8px}
.dsrc-ghost:hover:not(:disabled){border-color:transparent;color:var(--rc-ink)!important}

.dsrc-workspace{padding:15px;border-color:color-mix(in srgb,var(--rc-indigo) 20%,var(--rc-line));background:linear-gradient(152deg,var(--rc-indigo-soft),var(--rc-paper) 46%,color-mix(in srgb,var(--rc-teal) 4%,var(--rc-paper)) 96%);box-shadow:0 3px 14px #202b4a08}
.dsrc-ways{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:4px;border:1px solid var(--rc-line);border-radius:11px;background:var(--rc-fill)}
.dsrc .dsrc-way{--way:var(--rc-indigo);display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-width:0;min-height:42px;text-align:left;border:1px solid transparent;border-radius:8px;background:transparent;padding:6px 10px;transition:border-color .14s,background .14s,box-shadow .14s,color .14s}
.dsrc .dsrc-way[data-mode=public]{--way:var(--rc-teal)}
.dsrc .dsrc-way:hover:not(:disabled):not([aria-checked=true]){background:color-mix(in srgb,var(--way) 5%,transparent);color:var(--way)}
.dsrc .dsrc-way[aria-checked=true]{border-color:color-mix(in srgb,var(--way) 42%,transparent);background:var(--rc-paper);color:var(--way);box-shadow:0 1px 4px #202b4a17}
.dsrc-way-icon{display:grid;place-items:center;flex:none}
.dsrc-way-icon svg{width:18px;height:18px}
.dsrc-way-copy{display:block;flex:none;min-width:0}
.dsrc-way-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-weight:650;white-space:nowrap}
.dsrc-confirm{margin-top:12px;padding:12px;border:1px solid color-mix(in srgb,var(--rc-warm) 25%,var(--rc-line));border-radius:10px;background:var(--rc-warm-soft)}
.dsrc-confirm .dsrc-actions{margin-top:10px}
.dsrc-stage{display:grid;grid-template-columns:minmax(128px,154px) minmax(0,1fr);gap:16px;align-items:start;margin-top:13px}
.dsrc-brief{display:flex;flex-direction:column;min-width:0}
.dsrc-connection-state{margin-top:0}
.dsrc-connection-state strong{display:block;font-size:14px;font-weight:650;line-height:1.5}
.dsrc-connection-state p{color:var(--rc-muted);font-size:12px;line-height:1.6;margin-top:5px;overflow-wrap:anywhere}
.dsrc-connection-actions{display:flex;margin-top:12px}
.dsrc-connection-actions .dsrc-button{width:100%;min-height:36px}
.dsrc-stop{border-color:color-mix(in srgb,var(--rc-warm) 35%,var(--rc-line));color:var(--rc-warm);background:color-mix(in srgb,var(--rc-warm) 4%,transparent)}
.dsrc-stop:hover:not(:disabled){background:color-mix(in srgb,var(--rc-warm) 9%,transparent);border-color:var(--rc-warm)}
.dsrc-toggle{display:flex;align-items:center;justify-content:center;gap:8px;min-height:32px;cursor:pointer;color:var(--rc-muted);font-size:12px;margin-top:6px}
.dsrc-toggle input{width:16px;height:16px;flex:none;accent-color:var(--rc-accent);margin:0}
.dsrc-inline-notice{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;margin-top:12px;border:1px solid color-mix(in srgb,var(--rc-indigo) 18%,var(--rc-line));border-radius:9px;background:var(--rc-indigo-soft);font-size:12px;line-height:1.55}
.dsrc-inline-notice[data-tone=warn]{border-color:color-mix(in srgb,var(--rc-warm) 25%,var(--rc-line));background:var(--rc-warm-soft)}
.dsrc-inline-notice[data-tone=danger]{border-color:color-mix(in srgb,var(--rc-danger) 25%,var(--rc-line));background:color-mix(in srgb,var(--rc-danger) 7%,var(--rc-paper))}
.dsrc-notice-copy{min-width:0;overflow-wrap:anywhere}
.dsrc-notice-action{flex:none;min-height:28px;padding:2px 8px;color:var(--rc-warm);border-color:color-mix(in srgb,var(--rc-warm) 28%,var(--rc-line));background:var(--rc-paper)}
.dsrc-pane-message{font-size:12px}
.dsrc-pane-message .dsrc-inline-notice{display:block}

.dsrc-scan{display:flex;flex-direction:column;align-items:center;min-width:0}
.dsrc-code{width:100%;max-width:154px;aspect-ratio:1;border:1px solid #d9dce5;border-radius:10px;background:#fff;display:grid;place-items:center;overflow:hidden;box-shadow:0 2px 7px #2530480b;transition:box-shadow .2s}
.dsrc-code[data-ready=true]{box-shadow:0 0 0 2.5px color-mix(in srgb,var(--rc-accent) 36%,transparent),0 2px 9px #25304814}
.dsrc-code img{width:100%;height:100%;display:block}
.dsrc-placeholder{width:100%;height:100%;display:grid;place-items:center;text-align:center;padding:12px;font-size:11px;line-height:1.6;color:#687080;background:repeating-linear-gradient(135deg,#f4f6fa 0 7px,#fafbfc 7px 14px)}
.dsrc-code-refresh{min-height:28px;margin-top:6px;font-size:12px}
.dsrc-steps{display:flex;flex-direction:column;align-items:flex-start;gap:7px;width:100%;margin-top:13px;padding-top:11px;border-top:1px dashed var(--rc-line)}
.dsrc-step{display:inline-flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:1.5;color:var(--rc-muted)}
.dsrc-number{flex:none;width:17px;height:17px;display:grid;place-items:center;border-radius:50%;background:color-mix(in srgb,var(--rc-teal) 10%,var(--rc-paper));color:var(--rc-teal);font-size:9px;font-weight:700}
.dsrc-pin{display:block;min-width:0;padding:9px 11px;border:1px solid color-mix(in srgb,var(--rc-warm) 20%,var(--rc-line));border-radius:9px;background:var(--rc-warm-soft);margin-top:12px!important}
.dsrc-pin-head{display:flex;align-items:center;gap:7px;min-width:0}
.dsrc-pin-kind{padding:0 5px;border-radius:4px;background:color-mix(in srgb,var(--rc-warm) 11%,transparent);color:var(--rc-warm);font-size:10px;line-height:18px}
.dsrc-secret{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;margin-top:4px}
.dsrc-secret code{padding:1px 8px;border-radius:6px;background:color-mix(in srgb,var(--rc-warm) 8%,transparent);font:600 19px/28px ui-monospace,Consolas,monospace;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.dsrc-secret .dsrc-button{min-height:28px;padding:2px 6px;font-size:12px}
.dsrc-pin .dsrc-note{margin-top:0!important;font-size:11px}
.dsrc-pin .dsrc-input{margin-top:0}
.dsrc-pair-link{display:flex;align-items:center;gap:8px;min-width:0;margin-top:12px;padding-top:10px;border-top:1px solid var(--rc-line)}
.dsrc-link{min-width:0;flex:1;padding:5px 8px;border-radius:7px;background:var(--rc-fill);color:var(--rc-muted);font:11px/20px ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsrc-pair-link .dsrc-button{min-height:30px;padding:3px 9px;font-size:12px}
.dsrc-networks{margin-top:8px}
.dsrc-networks summary{min-height:26px;font-size:12px;font-weight:400;color:var(--rc-muted)}
.dsrc-alt-links{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;padding-top:6px}
.dsrc-address-button{max-width:100%;height:auto;min-height:28px;padding:2px 8px;font:11px/18px ui-monospace,Consolas,monospace;white-space:normal;overflow-wrap:anywhere;text-align:left}
.dsrc-panel-message{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:12px;padding:9px 11px;border:1px solid color-mix(in srgb,var(--rc-indigo) 18%,var(--rc-line));border-radius:9px;background:var(--rc-indigo-soft);color:var(--rc-muted);font-size:12px;overflow-wrap:anywhere}
.dsrc-panel-message[data-tone=warn]{border-color:color-mix(in srgb,var(--rc-warm) 24%,var(--rc-line));background:var(--rc-warm-soft);color:var(--rc-warm)}
.dsrc-panel-message[data-tone=danger]{border-color:color-mix(in srgb,var(--rc-danger) 24%,var(--rc-line));background:color-mix(in srgb,var(--rc-danger) 7%,var(--rc-paper));color:var(--rc-danger)}
.dsrc-copy-fallback{width:100%;min-height:64px;resize:vertical;border:1px solid var(--rc-line);border-radius:7px;background:var(--rc-paper);padding:8px;font:12px/1.5 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.dsrc-loading{display:flex;align-items:center;justify-content:center;gap:14px;min-height:200px}
.dsrc-loading .dsrc-note{margin-top:3px!important}
.dsrc-loading-mark{width:24px;height:24px;flex:none;border:2px solid var(--rc-indigo-soft);border-top-color:var(--rc-indigo);border-radius:50%;animation:dsrc-spin .9s linear infinite}

.dsrc-requests{border-color:color-mix(in srgb,var(--rc-warm) 38%,var(--rc-line));background:linear-gradient(140deg,var(--rc-warm-soft),var(--rc-paper) 72%)}
.dsrc-device{padding:11px 0;border-top:1px solid var(--rc-line)}
.dsrc-requests>.dsrc-device{margin-top:10px}
.dsrc-device-list{max-height:340px;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}
.dsrc-device-list>.dsrc-device:first-child{margin-top:10px}
.dsrc-device-list>.dsrc-device:last-child{padding-bottom:0}
.dsrc-devices>.dsrc-note{padding-top:8px;border-top:1px solid var(--rc-line)}
.dsrc-devices:has(.dsrc-device-list)>.dsrc-note{border-top:0;padding-top:0}
.dsrc-avatar{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:50%;background:color-mix(in srgb,var(--tone) 13%,transparent);color:var(--tone);font-weight:700;font-size:13px}
.dsrc-avatar[data-tone=indigo]{--tone:var(--rc-indigo)}
.dsrc-avatar[data-tone=teal]{--tone:var(--rc-teal)}
.dsrc-avatar[data-tone=violet]{--tone:var(--rc-violet)}
.dsrc-avatar[data-tone=warm]{--tone:var(--rc-warm)}
.dsrc-device-main{flex:1;min-width:0}
.dsrc-device-meta{color:var(--rc-muted);font-size:12px;margin-top:3px;overflow-wrap:anywhere}
.dsrc-device-name{font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.dsrc-tag{flex:none;font-size:10px;font-weight:500;line-height:18px;padding:0 7px;border-radius:999px;background:var(--rc-fill);color:var(--rc-muted)}
.dsrc-tag[data-way=lan]{background:var(--rc-indigo-soft);color:var(--rc-indigo)}
.dsrc-tag[data-way=public]{background:var(--rc-teal-soft);color:var(--rc-teal)}
.dsrc-online{background:color-mix(in srgb,var(--rc-teal) 11%,transparent);color:var(--rc-teal)}
.dsrc-pending{background:color-mix(in srgb,var(--rc-warm) 12%,transparent);color:var(--rc-warm)}
.dsrc-rename{height:32px;width:220px;max-width:100%;border:1px solid var(--rc-accent);border-radius:8px;background:var(--rc-paper);padding:0 8px;font-weight:600}

.dsrc-preferences{padding:0 15px}
.dsrc-preferences[data-needed=true]{border-color:color-mix(in srgb,var(--rc-warm) 42%,var(--rc-line))}
.dsrc summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px;cursor:pointer;list-style:none;font-weight:600}
.dsrc summary::-webkit-details-marker{display:none}
.dsrc summary::after{content:'';flex:none;width:7px;height:7px;margin:0 5px 4px 0;border-right:1.5px solid var(--rc-muted);border-bottom:1.5px solid var(--rc-muted);transform:rotate(45deg);transition:transform .15s}
.dsrc details[open]>summary::after{transform:rotate(225deg);margin-bottom:-5px;margin-top:4px}
.dsrc-preferences>summary{min-height:52px}
.dsrc-settings-title{display:flex;align-items:center;gap:9px;flex:none}
.dsrc-summary-value{margin-left:auto;color:var(--rc-muted);font-size:11px;font-weight:400;text-align:right;overflow-wrap:anywhere}
.dsrc-needs-attention{color:var(--rc-warm);font-weight:600}
.dsrc-preferences-body{display:flex;flex-direction:column;gap:16px;padding:13px 0 4px;border-top:1px solid var(--rc-line)}
.dsrc-setting-group{min-width:0}
.dsrc-setting-group+.dsrc-setting-group{padding-top:14px;border-top:1px solid var(--rc-line)}
.dsrc-setting-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.dsrc-setting-kicker{font-size:11px;color:var(--rc-muted)}
.dsrc-field{min-width:0;margin-top:14px}
.dsrc-domain-field{margin-top:0}
.dsrc-field>label{display:block;color:var(--rc-muted);font-size:12px;font-weight:600;line-height:20px}
.dsrc-input{display:flex;align-items:center;gap:8px;min-width:0;margin-top:6px}
.dsrc-input input{flex:1;min-width:0;width:100%;height:34px;border:1px solid var(--rc-line);border-radius:8px;background:var(--rc-paper);padding:0 10px}
.dsrc-input input[aria-invalid=true]{border-color:var(--rc-danger);background:color-mix(in srgb,var(--rc-danger) 4%,var(--rc-paper))}
.dsrc-input .dsrc-button{flex:none}
.dsrc-setting-row{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap;min-width:0;margin-top:12px}
.dsrc-status-note{display:inline-flex;align-items:baseline;gap:8px;min-width:0;color:var(--rc-muted);font-size:12px}
.dsrc-status-label{flex:none;font-weight:600}
.dsrc-status-value{min-width:0;overflow-wrap:anywhere}
.dsrc-status-note[data-tone=ok] .dsrc-status-value{color:var(--rc-success)}
.dsrc-status-note[data-tone=danger] .dsrc-status-value{color:var(--rc-danger)}
.dsrc-status-note[data-tone=warn] .dsrc-status-value{color:var(--rc-warning)}
.dsrc-certificate{padding-top:12px;border-top:1px solid var(--rc-line)}
.dsrc-certificate>.dsrc-setting-row{margin-top:0}
.dsrc-check{display:flex;align-items:flex-start;gap:9px;cursor:pointer;margin-top:13px;padding-top:12px;border-top:1px solid var(--rc-line)}
.dsrc-check input{width:16px;height:16px;flex:none;margin:2px 0 0;accent-color:var(--rc-accent)}
.dsrc-check-copy{display:block;min-width:0}
.dsrc-check .dsrc-note{margin-top:3px!important}
.dsrc-mode{display:inline-flex;gap:2px;max-width:100%;padding:3px;border-radius:9px;background:var(--rc-fill)}
.dsrc-mode button{border:0;background:transparent;color:var(--rc-muted);border-radius:7px;min-height:30px;padding:3px 12px;font-size:12px;white-space:nowrap}
.dsrc-mode button[aria-pressed=true]{background:var(--rc-paper);color:var(--rc-indigo);font-weight:650;box-shadow:0 1px 3px #202b4a1a}
.dsrc-proxy-field{margin-top:10px}
.dsrc-native-link{display:inline-block;margin-top:8px;color:var(--rc-accent);font-size:12px}
.dsrc-appearance{padding-top:14px;border-top:1px solid var(--rc-line)}
.dsrc-appearance>.dsrc-mode{margin-top:7px}
.dsrc-appearance-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}
.dsrc-swatches{display:inline-flex;align-items:center;gap:10px;padding:4px}
.dsrc .dsrc-swatch{width:22px;height:22px;flex:none;padding:0;border-radius:50%;border:3px solid var(--rc-paper);background:var(--rc-swatch);box-shadow:0 0 0 1px var(--rc-line)}
.dsrc .dsrc-swatch[aria-checked=true]{box-shadow:0 0 0 2px var(--rc-ink)}

.dsrc-entry{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:0;color:inherit;background:transparent;border-radius:8px;padding:8px;min-width:36px;min-height:36px;font:inherit;cursor:pointer;position:relative;flex:none}
.dsrc-entry-anchor{display:contents}
.dsrc-inline-action{display:inline-flex;align-items:center;flex:none}
.dsrc-entry:hover{background:#77736c15}
.dsrc-entry-dot{position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--rc-warm,#D97757);box-shadow:0 0 0 2px var(--dsw-alias-background-primary,#fff)}
.dsrc-entry svg{width:18px;height:18px}
.dsrc-dialog{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e4e0d8);background:var(--dsw-alias-background-primary,#fff);color:inherit;border-radius:16px;padding:20px 22px 22px;width:min(960px,calc(100vw - 32px));max-height:calc(100dvh - 40px);overflow:auto;font:13px/1.55 var(--dsh-font-family,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif);box-shadow:0 24px 80px #00000040}
.dsrc-dialog::backdrop{background:#20233480;backdrop-filter:blur(3px)}
.dsrc-close{position:sticky;top:0;float:right;z-index:1;width:30px;height:30px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:inherit;font-size:20px;line-height:1;cursor:pointer;margin:-4px -6px 0 8px}
.dsrc-close:hover{background:#77736c22}
.dsrc-dialog.dsrc-prompt{width:min(400px,calc(100vw - 32px))}
.dsrc-prompt-device{font-size:15px;font-weight:600;margin-top:12px!important}
.dsrc-prompt-actions{justify-content:flex-end;margin-top:18px}
.dsrc-toast{position:fixed;left:50%;top:28px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;padding:10px 18px;border-radius:999px;background:#242938;color:#fff;font-size:14px;font-weight:600;box-shadow:0 8px 28px #00000047;animation:dsrc-toast-in .18s ease-out}
.dsrc-toast svg{width:16px;height:16px;color:#81d7b4}
@keyframes dsrc-spin{to{transform:rotate(360deg)}}
@keyframes dsrc-pulse{50%{opacity:.35}}
@keyframes dsrc-toast-in{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}

@container(max-width:700px){
.dsrc-layout{grid-template-columns:minmax(0,1fr)}
}
@container(max-width:480px){
.dsrc-head{gap:8px;flex-wrap:wrap}
.dsrc-surface{padding:14px}
.dsrc-workspace{padding:13px}
.dsrc-ways{grid-template-columns:1fr;gap:4px}
.dsrc .dsrc-way{justify-content:flex-start;min-height:44px}
.dsrc-stage{grid-template-columns:minmax(0,1fr);gap:14px}
.dsrc-scan{align-items:center}
.dsrc-code{width:176px;max-width:176px}
.dsrc-device{flex-wrap:wrap}
.dsrc-device-main{flex-basis:100%}
.dsrc-device>.dsrc-actions{justify-content:flex-end;width:100%}
.dsrc-preferences>summary{align-items:flex-start;gap:8px;padding:12px 0}
.dsrc-settings-title{min-height:26px}
.dsrc-summary-value{max-width:46%;line-height:1.5;padding-top:2px}
.dsrc-input{align-items:stretch;flex-wrap:wrap}
.dsrc-input input{flex-basis:100%}
.dsrc-input .dsrc-button{flex:1}
.dsrc-setting-row{align-items:flex-start}
.dsrc-status-note{align-items:flex-start;flex-direction:column;gap:2px}
.dsrc-inline-notice{align-items:flex-start;flex-wrap:wrap}
.dsrc-notice-action{margin-left:auto}
.dsrc-mode{display:flex;width:100%}
.dsrc-mode button{flex:1;min-width:0;padding-right:5px;padding-left:5px;white-space:normal}
.dsrc-dialog{padding:16px}
}
@container(max-width:350px){
.dsrc-pair-link{align-items:stretch;flex-direction:column}
.dsrc-link{width:100%;flex:none}
.dsrc-pair-link .dsrc-button{align-self:flex-end}
}
@media(max-width:560px){
.dsrc{font-size:16px}
.dsrc h3{font-size:16px}
.dsrc-button{min-height:44px;font-size:16px}
.dsrc-connection-actions .dsrc-button{min-height:44px}
.dsrc-input input{height:44px;font-size:16px}
.dsrc-mode button{min-height:44px;font-size:14px}
.dsrc .dsrc-way{min-height:46px;padding:10px 12px}
.dsrc-toggle{min-height:44px;font-size:14px}
.dsrc-toggle input{width:20px;height:20px}
.dsrc .dsrc-swatch{width:44px;height:44px;min-height:44px}
.dsrc-muted,.dsrc-note,.dsrc-sub,.dsrc-summary-value,.dsrc-way-name,.dsrc-field-label,.dsrc-field>label,.dsrc-status-note,.dsrc-step,.dsrc-connection-state p,.dsrc-inline-notice,.dsrc-panel-message{font-size:14px}
.dsrc-connection-state strong{font-size:16px}
.dsrc-setting-kicker{font-size:12px}
.dsrc-code-refresh,.dsrc-secret .dsrc-button,.dsrc-pair-link .dsrc-button,.dsrc-notice-action{min-height:44px;font-size:14px}
.dsrc-secret code{font-size:22px;line-height:32px}
.dsrc-placeholder{font-size:14px}
}
@media(prefers-reduced-motion:reduce){.dsrc *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media(prefers-color-scheme:dark){
.dsrc{--rc-ink:var(--dsw-alias-label-primary,#eeedf4);--rc-muted:var(--dsw-alias-label-secondary,#adaeba);--rc-line:var(--dsw-alias-border-l2,#414451);--rc-paper:var(--dsw-alias-background-primary,#292b33);--rc-indigo:#a8b4ff;--rc-teal:#78cec0;--rc-violet:#b7a5f5;--rc-warm:#e4ae75;--rc-slate:#9aa7b4;--rc-danger:var(--dsw-alias-color-error,#EF9181);--rc-success:var(--dsw-alias-color-success,#83d2a6)}
.dsrc-code{border-color:#4a4e5c}
.dsrc-placeholder{color:#9aa2b1;background:repeating-linear-gradient(135deg,#32353f 0 7px,#2e313b 7px 14px)}
.dsrc-dialog{background:var(--dsw-alias-background-primary,#24262d)}
}
.dsrc{--rc-accent:var(--cl-accent,#D97757);--rc-accent-ink:var(--cl-accent-ink,#fff)}
`
