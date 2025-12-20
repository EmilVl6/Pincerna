(function() {
	const API_BASE = '/cloud/api';
	let currentPath = '/';
	let selectedFile = null;
	let metricsInterval = null;
	let vpnInterval = null;
	window.pincernaApp = {};
	function getToken() {
		return localStorage.getItem('pincerna_token');
	}
	function api(endpoint, options = {}) {
		const token = getToken();
		options.headers = options.headers || {};
		if (token) {
			options.headers['Authorization'] = token;
		}
		return fetch(API_BASE + endpoint, options).then(r => {
			if (!r.ok) throw new Error('API error: ' + r.status);
			return r.json();
		});
	}
	function formatBytes(bytes) {
		if (bytes === 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
	}
	function formatUptime(seconds) {
		const d = Math.floor(seconds / 86400);
		const h = Math.floor((seconds % 86400) / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		if (d > 0) return d + 'd ' + h + 'h';
		if (h > 0) return h + 'h ' + m + 'm';
		return m + 'm';
	}
	function loadMetrics() {
		fetch(API_BASE + '/metrics')
			.then(r => r.json())
			.then(data => {
				const cpuEl = document.getElementById('cpu-value');
				if (cpuEl) {
					cpuEl.textContent = data.cpu + '%';
					const bar = document.getElementById('cpu-bar');
					if (bar) bar.style.width = data.cpu + '%';
				}
				const memEl = document.getElementById('memory-value');
				if (memEl) {
					memEl.textContent = data.memory + '%';
					const bar = document.getElementById('memory-bar');
					if (bar) bar.style.width = data.memory + '%';
					const detail = document.getElementById('memory-detail');
					if (detail) detail.textContent = formatBytes(data.memory_used) + ' / ' + formatBytes(data.memory_total);
				}
				const diskEl = document.getElementById('disk-value');
				if (diskEl) {
					diskEl.textContent = data.disk + '%';
					const bar = document.getElementById('disk-bar');
					if (bar) bar.style.width = data.disk + '%';
					const detail = document.getElementById('disk-detail');
					if (detail) detail.textContent = formatBytes(data.disk_used) + ' / ' + formatBytes(data.disk_total);
				}
				const netEl = document.getElementById('network-value');
				if (netEl) {
					netEl.innerHTML = '↑' + formatBytes(data.net_sent) + ' ↓' + formatBytes(data.net_recv);
				}
				const uptimeEl = document.getElementById('uptime-value');
				if (uptimeEl) {
					uptimeEl.textContent = formatUptime(data.uptime);
				}
				const procEl = document.getElementById('processes-value');
				if (procEl) {
					procEl.textContent = data.process_count;
				}
				const tempEl = document.getElementById('temp-value');
				if (tempEl && data.cpu_temp) {
					tempEl.textContent = data.cpu_temp + '°C';
				}
			})
			.catch(err => console.error('Metrics error:', err));
	}
	function checkVPNStatus() {
		api('/vpn/status')
			.then(data => {
				updateVPNUI(data.connected);
				if (data.connected) {
					getVPNStats();
				}
			})
			.catch(err => {
				updateVPNUI(false);
			});
	}
	function updateVPNUI(connected) {
		const btn = document.getElementById('vpn-toggle');
		const status = document.getElementById('vpn-status');
		const indicator = document.getElementById('vpn-indicator');
		const statsEl = document.getElementById('vpn-stats');
		if (btn) {
			btn.textContent = connected ? 'Disconnect' : 'Connect';
			btn.className = connected ? 'vpn-btn connected' : 'vpn-btn';
		}
		if (status) {
			status.textContent = connected ? 'Connected' : 'Disconnected';
			status.className = connected ? 'vpn-status connected' : 'vpn-status';
		}
		if (indicator) {
			indicator.className = connected ? 'vpn-indicator connected' : 'vpn-indicator';
		}
		if (statsEl) {
			statsEl.style.display = connected ? 'block' : 'none';
		}
	}
	function getVPNStats() {
		api('/vpn/stats')
			.then(data => {
				const peersEl = document.getElementById('vpn-peers');
				const rxEl = document.getElementById('vpn-rx');
				const txEl = document.getElementById('vpn-tx');
				if (peersEl) peersEl.textContent = data.peer_count || 0;
				if (rxEl) rxEl.textContent = formatBytes(data.transfer_rx || 0);
				if (txEl) txEl.textContent = formatBytes(data.transfer_tx || 0);
			})
			.catch(err => console.error('VPN stats error:', err));
	}
	function toggleVPN() {
		const btn = document.getElementById('vpn-toggle');
		if (btn) btn.disabled = true;
		api('/vpn/toggle', { method: 'POST' })
			.then(data => {
				updateVPNUI(data.connected);
				if (data.connected) {
					setTimeout(getVPNStats, 1000);
				}
			})
			.catch(err => {
				console.error('VPN toggle error:', err);
				alert('Failed to toggle VPN');
			})
			.finally(() => {
				if (btn) btn.disabled = false;
			});
	}
	function loadFiles(path) {
		currentPath = path || '/';
		api('/files?path=' + encodeURIComponent(currentPath))
			.then(data => {
				renderFileList(data.files);
				updateBreadcrumb(currentPath);
			})
			.catch(err => {
				console.error('Files error:', err);
			});
	}
	function renderFileList(files) {
		const list = document.getElementById('file-list');
		if (!list) return;
		list.innerHTML = '';
		if (currentPath !== '/') {
			const upItem = document.createElement('div');
			upItem.className = 'file-item';
			upItem.innerHTML = '<span class="file-icon">📁</span><span class="file-name">..</span><span class="file-size"></span><span class="file-date"></span>';
			upItem.onclick = () => {
				const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
				loadFiles(parent);
			};
			list.appendChild(upItem);
		}
		files.forEach(file => {
			const item = document.createElement('div');
			item.className = 'file-item';
			item.dataset.path = file.path;
			item.dataset.isDir = file.is_dir;
			item.dataset.name = file.name;
			const icon = file.is_dir ? '📁' : getFileIcon(file.name);
			item.innerHTML = '<span class="file-icon">' + icon + '</span><span class="file-name">' + escapeHtml(file.name) + '</span><span class="file-size">' + (file.size || '') + '</span><span class="file-date">' + (file.mtime || '') + '</span>';
			item.onclick = (e) => {
				if (e.detail === 2) {
					if (file.is_dir) {
						loadFiles(file.path);
					} else {
						downloadFile(file.path);
					}
				} else {
					selectFile(item, file);
				}
			};
			item.oncontextmenu = (e) => {
				e.preventDefault();
				selectFile(item, file);
				showContextMenu(e.pageX, e.pageY, file);
			};
			list.appendChild(item);
		});
	}
	function selectFile(item, file) {
		document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
		item.classList.add('selected');
		selectedFile = file;
	}
	function getFileIcon(name) {
		const ext = name.split('.').pop().toLowerCase();
		const icons = {
			'pdf': '📄', 'doc': '📝', 'docx': '📝', 'txt': '📝',
			'jpg': '🖼️', 'jpeg': '🖼️', 'png': '🖼️', 'gif': '🖼️', 'webp': '🖼️',
			'mp3': '🎵', 'wav': '🎵', 'flac': '🎵',
			'mp4': '🎬', 'mkv': '🎬', 'avi': '🎬', 'mov': '🎬',
			'zip': '📦', 'rar': '📦', 'tar': '📦', 'gz': '📦', '7z': '📦',
			'js': '📜', 'py': '🐍', 'html': '🌐', 'css': '🎨', 'json': '📋'
		};
		return icons[ext] || '📄';
	}
	function escapeHtml(text) {
		const div = document.createElement('div');
		div.textContent = text;
		return div.innerHTML;
	}
	function updateBreadcrumb(path) {
		const bc = document.getElementById('breadcrumb');
		if (!bc) return;
		const parts = path.split('/').filter(p => p);
		let html = '<span class="bc-item" onclick="pincernaApp.loadFiles(\'/\')">Home</span>';
		let cumPath = '';
		parts.forEach(part => {
			cumPath += '/' + part;
			const p = cumPath;
			html += ' / <span class="bc-item" onclick="pincernaApp.loadFiles(\'' + p + '\')">' + escapeHtml(part) + '</span>';
		});
		bc.innerHTML = html;
	}
	function showContextMenu(x, y, file) {
		hideContextMenu();
		const menu = document.createElement('div');
		menu.id = 'context-menu';
		menu.className = 'context-menu';
		const items = [
			{ label: 'Download', action: () => downloadFile(file.path), show: !file.is_dir },
			{ label: 'Rename', action: () => renameFile(file) },
			{ label: 'Move', action: () => moveFile(file) },
			{ label: 'Delete', action: () => deleteFile(file.path) }
		];
		items.forEach(item => {
			if (item.show === false) return;
			const el = document.createElement('div');
			el.className = 'context-menu-item';
			el.textContent = item.label;
			el.onclick = () => {
				hideContextMenu();
				item.action();
			};
			menu.appendChild(el);
		});
		menu.style.left = x + 'px';
		menu.style.top = y + 'px';
		document.body.appendChild(menu);
		document.addEventListener('click', hideContextMenu, { once: true });
	}
	function hideContextMenu() {
		const menu = document.getElementById('context-menu');
		if (menu) menu.remove();
	}
	function downloadFile(path) {
		const token = getToken();
		const url = API_BASE + '/files/download?path=' + encodeURIComponent(path);
		const a = document.createElement('a');
		a.href = url;
		a.download = path.split('/').pop();
		fetch(url, { headers: { 'Authorization': token } })
			.then(r => r.blob())
			.then(blob => {
				const url = URL.createObjectURL(blob);
				a.href = url;
				a.click();
				URL.revokeObjectURL(url);
			});
	}
	function uploadFile() {
		const input = document.getElementById('file-upload');
		if (!input || !input.files.length) return;
		const file = input.files[0];
		const formData = new FormData();
		formData.append('file', file);
		formData.append('path', currentPath);
		const progressBar = document.getElementById('upload-progress');
		const progressFill = document.getElementById('upload-progress-fill');
		const progressText = document.getElementById('upload-progress-text');
		if (progressBar) progressBar.style.display = 'block';
		const xhr = new XMLHttpRequest();
		xhr.open('POST', API_BASE + '/files/upload');
		xhr.setRequestHeader('Authorization', getToken());
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) {
				const pct = Math.round((e.loaded / e.total) * 100);
				if (progressFill) progressFill.style.width = pct + '%';
				if (progressText) progressText.textContent = pct + '%';
			}
		};
		xhr.onload = () => {
			if (progressBar) progressBar.style.display = 'none';
			if (progressFill) progressFill.style.width = '0%';
			if (xhr.status === 200) {
				loadFiles(currentPath);
			} else {
				alert('Upload failed');
			}
			input.value = '';
		};
		xhr.onerror = () => {
			if (progressBar) progressBar.style.display = 'none';
			alert('Upload failed');
			input.value = '';
		};
		xhr.send(formData);
	}
	function deleteFile(path) {
		if (!confirm('Delete this item?')) return;
		api('/files?path=' + encodeURIComponent(path), { method: 'DELETE' })
			.then(() => loadFiles(currentPath))
			.catch(err => alert('Delete failed: ' + err.message));
	}
	function renameFile(file) {
		const newName = prompt('Enter new name:', file.name);
		if (!newName || newName === file.name) return;
		api('/files/rename', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: file.path, new_name: newName })
		})
			.then(() => loadFiles(currentPath))
			.catch(err => alert('Rename failed: ' + err.message));
	}
	function createFolder() {
		const name = prompt('Enter folder name:');
		if (!name) return;
		api('/files/mkdir', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: currentPath, name: name })
		})
			.then(() => loadFiles(currentPath))
			.catch(err => alert('Create folder failed: ' + err.message));
	}
	function moveFile(file) {
		const dest = prompt('Enter destination path:', currentPath);
		if (!dest) return;
		api('/files/move', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: file.path, destination: dest })
		})
			.then(() => loadFiles(currentPath))
			.catch(err => alert('Move failed: ' + err.message));
	}
	function init() {
		loadMetrics();
		metricsInterval = setInterval(loadMetrics, 5000);
		checkVPNStatus();
		vpnInterval = setInterval(checkVPNStatus, 10000);
		loadFiles('/');
		const vpnBtn = document.getElementById('vpn-toggle');
		if (vpnBtn) vpnBtn.onclick = toggleVPN;
		const uploadInput = document.getElementById('file-upload');
		if (uploadInput) uploadInput.onchange = uploadFile;
		const newFolderBtn = document.getElementById('new-folder-btn');
		if (newFolderBtn) newFolderBtn.onclick = createFolder;
	}
	window.pincernaApp.loadFiles = loadFiles;
	window.pincernaApp.toggleVPN = toggleVPN;
	window.pincernaApp.createFolder = createFolder;
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
