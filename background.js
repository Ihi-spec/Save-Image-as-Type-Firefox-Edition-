let messages;

// some old chrome doesn't support browser.i18n.getMessage in service worker.
if (!browser.i18n?.getMessage) {
	if (!browser.i18n) {
		browser.i18n = {};
	}
	browser.i18n.getMessage = (key, args) => {
		if (key == 'View_in_store') {
			return 'View in store';
		}
		if (key == 'Save_as' && args?.[0]) {
			return 'Save as ' + args[0];
		}
		return key;
	};
}

function download(url, filename) {
	browser.downloads.download(
		{ url, filename + ".png", saveAs: true },
		function(downloadId) {
			if (!downloadId) {
				let msg = browser.i18n.getMessage('errorOnSaving');
				if (browser.runtime.lastError) {
					msg += ': \n'+ browser.runtime.lastError.message;
				}
				notify(msg);
			}
		}
	);
}

async function fetchAsDataURL(src, callback) {
	if (src.startsWith('data:')) {
		callback(null, src);
		return;
	}
	fetch(src)
	.then(res => res.blob())
	.then(blob => {
		if (!blob.size) {
			throw 'Fetch failed of 0 size';
		}
		let reader = new FileReader();
		reader.onload = async function(evt){
			let dataurl = evt.target.result;
			callback(null, dataurl);
		};
		reader.readAsDataURL(blob);
	})
	.catch(error => callback(error.message || error));
}

function getSuggestedFilename(src, type) {
	//special for chrome web store apps
	if(src.match(/googleusercontent\.com\/[0-9a-zA-Z]{30,}/)){
		return 'screenshot.'+type;
	}
	if (src.startsWith('blob:') || src.startsWith('data:')) {
		return 'Untitled.'+type;
	}
	let filename = src.replace(/[?#].*/,'').replace(/.*[\/]/,'').replace(/\+/g,' ');
	filename = decodeURIComponent(filename);
	filename = filename.replace(/[\x00-\x7f]+/g, function (s){
		return s.replace(/[^\w\-\.\,@ ]+/g,'');
	});
	while(filename.match(/\.[^0-9a-z]*\./)){
		filename = filename.replace(/\.[^0-9a-z]*\./g,'.');
	}
	filename = filename.replace(/\s\s+/g,' ').trim();
	filename = filename.replace(/\.(jpe?g|png|gif|webp|svg)$/gi,'').trim();
	if(filename.length > 32){
		filename = filename.substr(0,32);
	}
	filename = filename.replace(/[^0-9a-z]+$/i,'').trim();
	if(!filename){
		filename = 'image';
	}
	return filename+'.'+type;
}

function notify(msg) {
	if (msg.error) {
		msg = (browser.i18n.getMessage(msg.error) || msg.error) + '\n'+ (msg.srcUrl || msg.src);
	}
}

function loadMessages() {
	if (!messages) {
		messages = {};
		['errorOnSaving', 'errorOnLoading'].forEach(key => {
			messages[key] = browser.i18n.getMessage(key);
		});
	}
	return messages;
}

async function hasOffscreenDocument(path) {
	const offscreenUrl = browser.runtime.getURL(path);
	const matchedClients = await clients.matchAll();
	for (const client of matchedClients) {
		if (client.url === offscreenUrl) {
			return true;
		}
	}
	return false;
}

browser.runtime.onInstalled.addListener(function () {
	loadMessages();
	['JPG','PNG','WebP'].forEach(function (type){
		browser.contextMenus.create({
			"id" : "save_as_" + type.toLowerCase(),
			"title" : browser.i18n.getMessage("Save_as", [type]),
			"type" : "normal",
			"contexts" : ["image"],
		});
	});
	browser.contextMenus.create({
		"id" : "sep_1",
		"type" : "separator",
		"contexts" : ["image"]
	});
	browser.contextMenus.create({
		"id" : "view_in_store",
		"title" : browser.i18n.getMessage("View_in_store"),
		"type" : "normal",
		"contexts" : ["image"],
	});
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	let {target, op} = message || {};
	if (target == 'background' && op) {
		if (op == 'download') {
			let {url, filename} = message;
			download(url, filename);
		} else if (op == 'notify') {
			let msg = message.message;
			if (msg && msg.error) {
				let msg2 = browser.i18n.getMessage(msg.error) || msg.error;
				if (msg.src) {
					msg2 += '\n'+ msg.src;
				}
				notify(msg2);
			} else {
				notify(message);
			}
		} else {
			console.warn('unknown op: ' + op);
		}
	}
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	let {menuItemId, mediaType, srcUrl} = info;
	let connectTab = () => {
		// for old chrome v108-
		let port = browser.tabs.connect(
			tab.id,
			{
				name: 'convertType',
				frameId: info.frameId,
			},
		);
		return port;
	};
	if (menuItemId.startsWith('save_as_')) {
		if (mediaType=='image' && srcUrl) {
			let type = menuItemId.replace('save_as_', '');
			let filename = getSuggestedFilename(srcUrl, type);
			loadMessages();
			let noChange = srcUrl.startsWith('data:image/' + (type == 'jpg' ? 'jpeg' : type) + ';');
			if (!browser.offscreen) {
				// for old chrome v108-
				let frameIds = info.frameId ? [] : void 0;
				await browser.scripting.executeScript({
					target: { tabId: tab.id, frameIds },
					files: ["offscreen.js"], // content script and offscreen use the same file.
				});
			}
			fetchAsDataURL(srcUrl, async function(error, dataurl) {
				if (error) {
					notify({error, srcUrl});
					return;
				}
				// offscreen api need chrome v109+
				if (!browser.offscreen) {
					// for old chrome v108-
					let port = connectTab();
					await port.postMessage({ op: noChange ? 'download' : 'convertType', target: 'content', src: dataurl, type, filename });
					return;
				}
				// for new chrome v109+
				if (noChange) {
					download(dataurl, filename);
					return;
				}
				const offscreenSrc = 'offscreen.html'
				if (!(await hasOffscreenDocument(offscreenSrc))) {
					await browser.offscreen.createDocument({
						url: browser.runtime.getURL(offscreenSrc),
						reasons: ['DOM_SCRAPING'],
						justification: 'Download a image for user',
					});
				}
				await browser.runtime.sendMessage({ op: 'convertType', target: 'offscreen', src: dataurl, type, filename });
			});
			return;
		} else {
			notify(browser.i18n.getMessage("errorIsNotImage"));
		}
		return;
	}
	if (menuItemId == 'view_in_store') {
		let url = "https://browser.google.com/webstore/detail/save-image-as-type/" + browser.i18n.getMessage("@@extension_id");
		browser.tabs.create({ url: url, index: tab.index + 1 });
		return;
	}
});
