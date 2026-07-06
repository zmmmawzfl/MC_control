// ========== 主题切换 ==========
function toggleTheme() {
    const body = document.body;
    const root = document.documentElement;
    const themeIcon = document.querySelector('#themeToggle i');
    if (body.classList.contains('dark-theme')) {
        body.classList.remove('dark-theme');
        root.classList.remove('dark-theme');
        localStorage.setItem('theme', 'light');
        if (themeIcon) themeIcon.className = 'fas fa-moon';
    } else {
        body.classList.add('dark-theme');
        root.classList.add('dark-theme');
        localStorage.setItem('theme', 'dark');
        if (themeIcon) themeIcon.className = 'fas fa-sun';
    }
}
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    const themeIcon = document.querySelector('#themeToggle i');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-theme');
        document.documentElement.classList.add('dark-theme');
        if (themeIcon) themeIcon.className = 'fas fa-sun';
    } else {
        if (themeIcon) themeIcon.className = 'fas fa-moon';
    }
}
document.addEventListener('DOMContentLoaded', initTheme);

// ========== 工具函数 ==========
function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function fuzzyMatch(keyword, text) {
    if (!keyword) return true;
    keyword = keyword.toLowerCase();
    text = text.toLowerCase();
    let ki = 0;
    for (let i = 0; i < text.length && ki < keyword.length; i++) {
        if (text[i] === keyword[ki]) ki++;
    }
    return ki === keyword.length;
}
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i> ${message}`;
    toast.className = `toast ${type} show`;
    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}
function hideModal(id) {
    document.getElementById(id).classList.remove('show');
}
function showModal(id) {
    document.getElementById(id).classList.add('show');
}
let confirmCallback = null;
function showConfirmModal(title, message, onConfirm) {
    document.getElementById('confirmTitle').textContent = title || '确认操作';
    document.getElementById('confirmMessage').textContent = message || '确定执行此操作吗？';
    document.getElementById('confirmModal').classList.add('show');
    confirmCallback = onConfirm;
}
document.getElementById('confirmOkBtn')?.addEventListener('click', () => {
    hideModal('confirmModal');
    if (typeof confirmCallback === 'function') {
        confirmCallback();
        confirmCallback = null;
    }
});

// ========== 认证检查 ==========
async function checkAuth() {
    try {
        const res = await fetch('/api/mc/servers');
        if (res.status === 401) {
            window.location.href = '/login.html';
            return false;
        }
        return true;
    } catch (e) {
        // 网络错误时也重定向到登录
        window.location.href = '/login.html';
        return false;
    }
}

/* global appendMcLog, renderPlayerList, updateMcStats, loadMcStatus, loadMcConfig, initMcStatsChart, updateMcStatsChart, loadMcLogs, loadMcPlayers, refreshMcPlayerList, loadMcServers */

// ========== WebSocket ==========
let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
        document.getElementById('wsStatus').classList.add('connected');
        document.getElementById('wsStatusText').textContent = '已连接';
        reconnectAttempts = 0;
        showToast('已连接到服务器', 'success');
        // 使用 '*' 订阅所有服务器
        ws.send(JSON.stringify({ type: 'subscribe_mc', serverId: '*' }));
        ws.send(JSON.stringify({ type: 'subscribe_mc_players', serverId: '*' }));
        ws.send(JSON.stringify({ type: 'subscribe_mc_stats', serverId: '*' }));
    };
    ws.onclose = (event) => {
        document.getElementById('wsStatus').classList.remove('connected');
        document.getElementById('wsStatusText').textContent = '已断开';
        if (event.code === 1008) {
            showToast('WebSocket 未授权，请重新登录', 'error');
            return;
        }
        if (!document.querySelector('body').dataset.unloading) {
            showToast('与服务器断开，正在重连...', 'error');
            if (reconnectAttempts < 6) {
                reconnectTimer = setTimeout(() => {
                    reconnectAttempts++;
                    connectWebSocket();
                }, Math.min(30000, 1000 * Math.pow(1.5, reconnectAttempts)));
            } else {
                showToast('重连失败，请刷新页面', 'error');
            }
        }
    };
    ws.onerror = (err) => console.error('WebSocket 错误:', err);
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('解析消息失败:', e);
        }
    };
}

function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'ws_connected':
            ws.send(JSON.stringify({ type: 'subscribe_mc', serverId: '*' }));
            ws.send(JSON.stringify({ type: 'subscribe_mc_players', serverId: '*' }));
            ws.send(JSON.stringify({ type: 'subscribe_mc_stats', serverId: '*' }));
            break;
        case 'mc_log':
            if (typeof appendMcLog === 'function') appendMcLog({ text: data.line, level: data.level });
            break;
        case 'mc_players':
            if (typeof renderPlayerList === 'function') {
                renderPlayerList(data.players || [], data.count || 0, data.max || 0);
                window.mcPlayersLastUpdate = Date.now();
            }
            break;
        case 'mc_stats':
            if (typeof updateMcStats === 'function') {
                updateMcStats(data.cpu, data.memory, data.tps);
            }
            break;
        default:
            break;
    }
}

// ========== 页面切换 ==========
document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        const page = item.dataset.page;
        document.querySelectorAll('.nav-item[data-page]').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
        document.getElementById(page + 'Page').style.display = 'block';
        document.getElementById('mcToolbar').style.display = 'flex';
        if (page === 'mc_stats') {
            if (typeof loadMcStatus === 'function') loadMcStatus();
            if (typeof loadMcConfig === 'function') loadMcConfig();
            setTimeout(() => {
                if (typeof initMcStatsChart === 'function') initMcStatsChart();
                if (typeof updateMcStatsChart === 'function') updateMcStatsChart();
            }, 100);
        } else if (page === 'mc_console') {
            if (typeof loadMcLogs === 'function') loadMcLogs();
            if (typeof loadMcStatus === 'function') loadMcStatus();
        } else if (page === 'mc_players') {
            if (typeof loadMcPlayers === 'function') loadMcPlayers();
            if (Date.now() - (window.mcPlayersLastUpdate || 0) > 15000 && typeof refreshMcPlayerList === 'function') {
                refreshMcPlayerList();
            }
        } else if (page === 'startup') {
            if (typeof loadMcConfig === 'function') loadMcConfig();
        }
    });
});

document.getElementById('mcParent')?.addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('mcSubItems').classList.toggle('open');
});
document.getElementById('mcParent')?.classList.add('open');
document.getElementById('mcSubItems')?.classList.add('open');

// 系统菜单切换
document.getElementById('systemParent')?.addEventListener('click', function() {
    this.classList.toggle('open');
    document.getElementById('systemSubItems').classList.toggle('open');
});

// ========== 退出登录 ==========
function logout() {
    showConfirmModal('退出登录', '确定要退出登录吗？', () => {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = '/logout';
    });
}

// ========== 更新当前时间 ==========
function updateCurrentTime() {
    const el = document.getElementById('currentTime');
    if (el) el.textContent = new Date().toLocaleString();
}
updateCurrentTime();
setInterval(updateCurrentTime, 1000);

// ========== 页面关闭清理 ==========
window.addEventListener('beforeunload', () => {
    document.body.dataset.unloading = 'true';
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
});

// ========== 启动 ==========
async function initApp() {
    const authed = await checkAuth();
    if (!authed) return;
    // 认证通过后初始化
    connectWebSocket();
    // 加载服务器列表（由 mc_console.js 处理）
    if (typeof loadMcServers === 'function') {
        loadMcServers();
    }
    // 默认显示第一个页面（性能监控）
    document.querySelector('.nav-item[data-page="mc_stats"]')?.click();
}

document.addEventListener('DOMContentLoaded', initApp);

// ========== 暴露全局函数供 HTML 调用 ==========
window.toggleTheme = toggleTheme;
window.showToast = showToast;
window.showModal = showModal;
window.hideModal = hideModal;
window.showConfirmModal = showConfirmModal;
window.logout = logout;
window.escapeHtml = escapeHtml;
window.fuzzyMatch = fuzzyMatch;