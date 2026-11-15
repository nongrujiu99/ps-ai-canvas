(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioChannelView = api;
}(this, function () {
  'use strict';

  // 渠道设置视图：让用户在面板里自己切换「百炼 / 第三方 API」。
  //
  // 之前这个能力只存在于 openai.env + 终端命令里，等于只有开发者能用。
  // 这里只负责 DOM 渲染和事件，不碰业务逻辑——真正的校验、持久化、热切换都在服务端
  // channel-store.js，面板保存后下一次生成就生效，不需要重启服务。
  //
  // 必须是 ES5（var + function）：PS 2021 之前的 CEP 内嵌 Chromium 61。

  var CONTROLS = ['workspace-id', 'api-key', 'base-url', 'openai-key', 'openai-model', 'openai-model-custom', 'openai-size-mode', 'channel-name', 'bfl-key', 'bfl-base-url', 'bfl-model', 'bfl-model-custom', 'bfl-name', 'save-channel'];

  // 「显示名称」的默认称呼。这个字面量只在这里写一次——设置页那段切换按钮、
  // 底部状态行、顶部渠道行三处都读它。以前分散在三处，改一处就出现「设置页叫
  // 第三方 API、顶部却叫 Gemini」这种自相矛盾的界面。
  var DEFAULT_CHANNEL_NAME = '第三方 API';
  var DEFAULT_BFL_NAME = 'FLUX';

  function channelName(channel, fallback) {
    return String((channel && channel.name) || '').trim() || (fallback || DEFAULT_CHANNEL_NAME);
  }

  // 只列**实测跑通过**的模型。没验证过的名字（比如 gemini-3-pro-image）不上清单：
  // 列出来就等于承诺「选它一定行」，而模型名拼错、渠道根本没有这个模型，都要等到
  // 上传完底稿才报错——用户白等一分钟，还以为插件坏了。
  //
  // sizeMode 跟模型绑定，因为这一项选错不会报错，只会让渠道按自己的默认比例重排画面：
  // Gemini 系认 image_size 档位（1K/2K/4K），gpt-image 系认像素 size。配错的后果是
  // 回图比例跟画布差 30~40%，扩图整张重画、接缝对不上，而日志里看起来一切正常。
  var MODELS = [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image（推荐）', sizeMode: 'tier' },
    { id: 'nano-banana-pro', label: 'Nano Banana Pro（备用，约慢一倍）', sizeMode: 'tier' },
    { id: 'gpt-image-2.6-flare', label: 'GPT-Image 2.6 Flare（像素尺寸）', sizeMode: 'pixels' }
  ];
  // Vertex AI 用另一套模型名，而且 Express Mode 的 AQ. Key 不能调 /models
  // （固定 401），拿不到列表——所以这份清单就是唯一来源，必须内置。
  // 名字和上面那份不通用：把中转站的名字填进 Vertex 只会 404。
  //
  // 只列实测存在过的 ID。「Nano Banana」是产品昵称不是模型 ID：
  // nano banana = gemini-2.5-flash-image、nano banana pro = gemini-3-pro-image、
  // 新一代 = gemini-3.1-flash-image。而 gemini-nano-banana-2.1 / -2 / -pro 这几个
  // 写法在 Vertex 上全是 404（NOT_FOUND Publisher model），列进下拉只会让人误选。
  // 昵称写在 label 里，让人认得出是同一张图。
  var VERTEX_MODELS = [
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image · Nano Banana 2', sizeMode: 'tier' },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image · Nano Banana Pro', sizeMode: 'tier' }
  ];
  // BFL 的手感完全不同：它不是一个模型干所有事，而是「一个操作一个端点」。
  // 所以这里只列**文生图**能用的模型；扩图和选区编辑各有专用端点（flux-pro-1.0-expand /
  // flux-pro-1.0-fill），不走这个下拉，也就没有「选错模型导致扩图重画」的风险。
  //
  // 两个 ID 都实测过：请求 768×512 回 768×512、请求 1024×768 回 1024×768，尺寸精确。
  // 这点比文生图好不好看更关键——面板有 12 个精确宽高，尺寸不守就等于整张重排。
  //
  // BFL 也不需要「尺寸模式」这一项：它直接收 width/height 整数，不存在档位这层歧义，
  // 而档位选错恰恰是最容易静默出错的地方（选错不报错，只把画面重排）。
  var BFL_MODELS = [
    { id: 'flux-pro-1.1', label: 'FLUX 1.1 Pro（便宜，实测约 8 秒）' },
    { id: 'flux-2-pro-preview', label: 'FLUX 2 Pro（最新，更贵）' }
  ];
  // 留一个出口：换了渠道商、清单里没有对应模型时不至于卡死。
  // 它不列任何「未验证」的名字，只是给一个手填位。
  var CUSTOM = '__custom__';
  var MODE_LABEL = { tier: '档位 1K/2K/4K', pixels: '像素尺寸' };

  function createChannelView(options) {
    var $ = options.$;
    var service = options.service;
    var state = { kind: 'aliyun', locked: false, vertex: false, picked: false };

    // 地址是不是 Vertex。面板不引服务端代码，这里只做一个粗判：
    // 域名里出现 aiplatform / generativelanguage，或路径里出现 publishers/google/models，
    // 就按 Vertex 处理。不锚定行首：用户填的是 https://aiplatform... ，域名前面是斜杠。
    function isVertexAddress(url) {
      return /aiplatform\.googleapis\.com|generativelanguage\.googleapis\.com|publishers\/google\/models/i.test(String(url || ''));
    }

    function setStatus(text, tone) {
      var node = $('channel-status');
      if (!node) return;
      node.textContent = text || '';
      node.className = tone ? 'status ' + tone : 'status';
    }

    function setTestStatus(text, tone) {
      var node = $('test-status');
      if (!node) return;
      node.textContent = text || '';
      node.className = tone ? 'status ' + tone : 'status';
    }

    function modelEntry(id, list) {
      var pool = list || MODELS.concat(VERTEX_MODELS);
      for (var i = 0; i < pool.length; i++) if (pool[i].id === id) return pool[i];
      return null;
    }

    function setCustomVisible(show) {
      var wrap = $('openai-model-custom-wrap');
      if (wrap) wrap.className = show ? '' : 'hidden';
    }

    // 下拉每次都整块重建：渠道只有一个，选项只有几条，没必要做「增量更新」那套。
    // selected 为空（还没配过）时默认选第一项，别让人面对一个空下拉发呆。
    function renderModels(selected, vertex) {
      var select = $('openai-model');
      if (!select) return;
      var list = vertex ? VERTEX_MODELS : MODELS;
      var html = '';
      for (var i = 0; i < list.length; i++) {
        html += '<option value="' + list[i].id + '">' + list[i].label + '</option>';
      }
      html += '<option value="' + CUSTOM + '">自定义模型名…</option>';
      select.innerHTML = html;
      var known = modelEntry(selected, list);
      // 已保存的名字不在这份清单里（换过协议、或渠道上了新模型）时落到自定义框，
      // 而不是悄悄改成清单第一项——那会让保存动作替用户改掉模型。
      select.value = known ? selected : (selected ? CUSTOM : list[0].id);
      setCustomVisible(select.value === CUSTOM);
      $('openai-model-custom').value = known || !selected ? '' : String(selected);
    }

    // BFL 的下拉只有「文生图模型」这一层含义：扩图和选区编辑各走一个固定端点，
    // 不在这里选。所以它不需要跟着地址变、也不需要联动尺寸模式。
    function renderBflModels(selected) {
      var select = $('bfl-model');
      if (!select) return;
      var html = '';
      for (var i = 0; i < BFL_MODELS.length; i++) {
        html += '<option value="' + BFL_MODELS[i].id + '">' + BFL_MODELS[i].label + '</option>';
      }
      html += '<option value="' + CUSTOM + '">自定义模型名…</option>';
      select.innerHTML = html;
      var known = false;
      for (var k = 0; k < BFL_MODELS.length; k++) if (BFL_MODELS[k].id === selected) known = true;
      // 和上面同一个规矩：存过的名字不在清单里就落到自定义框，绝不悄悄换成第一项。
      select.value = known ? selected : (selected ? CUSTOM : BFL_MODELS[0].id);
      var wrap = $('bfl-model-custom-wrap');
      if (wrap) wrap.className = select.value === CUSTOM ? '' : 'hidden';
      if ($('bfl-model-custom')) $('bfl-model-custom').value = known || !selected ? '' : String(selected);
    }

    function onBflModelChange() {
      var id = $('bfl-model').value;
      var wrap = $('bfl-model-custom-wrap');
      if (wrap) wrap.className = id === CUSTOM ? '' : 'hidden';
      if (id === CUSTOM) setStatus('自定义模型名：按 BFL 文档填写，只影响文生图；扩图和选区编辑不受它影响。', 'warn');
    }

    // 换模型就把尺寸模式跟着换掉，这是这个下拉存在的唯一理由。
    function onModelChange() {
      var id = $('openai-model').value;
      state.picked = true;
      setCustomVisible(id === CUSTOM);
      var entry = modelEntry(id);
      if (!entry) {
        setStatus('自定义模型名：请按渠道文档填写，尺寸模式要自己配对。', 'warn');
        return;
      }
      $('openai-size-mode').value = entry.sizeMode;
      setStatus('尺寸模式已跟着改成「' + MODE_LABEL[entry.sizeMode] + '」，保存后生效。', 'ok');
    }

    // 地址决定「用哪份模型清单」。改地址时如果协议变了，立刻换清单——
    // 否则用户把地址改成 Vertex 之后，下拉里还是一堆必然 404 的中转站名字。
    function onBaseUrlChange() {
      var vertex = isVertexAddress($('base-url').value);
      if (vertex === state.vertex) return;
      var picked = $('openai-model').value;
      // 用户自己选过的模型要留住（哪怕它在两边清单里都有）；只是「默认值」的话
      // 就跟着新协议走，否则切到 Vertex 会停留在中转站的推荐项上，看着像没切换成功。
      var keep = state.picked ? (picked === CUSTOM ? $('openai-model-custom').value.trim() : picked) : '';
      state.vertex = vertex;
      renderModels(keep, vertex);
      var entry = modelEntry($('openai-model').value, vertex ? VERTEX_MODELS : MODELS);
      if (entry) $('openai-size-mode').value = entry.sizeMode;
      setStatus(vertex
        ? '检测到 Vertex AI 地址：模型清单已换成 Vertex 的内置预设。Express Mode 不支持列模型，名字要按清单选。'
        : '检测到普通第三方 API 地址：模型清单已换回通用预设。', 'ok');
    }

    function selectTab(kind) {
      state.kind = kind === 'openai' ? 'openai' : (kind === 'bfl' ? 'bfl' : 'aliyun');
      $('channel-aliyun-tab').className = 'seg' + (state.kind === 'aliyun' ? ' active' : '');
      $('channel-openai-tab').className = 'seg' + (state.kind === 'openai' ? ' active' : '');
      if ($('channel-bfl-tab')) $('channel-bfl-tab').className = 'seg' + (state.kind === 'bfl' ? ' active' : '');
      $('channel-aliyun').className = 'channel-body' + (state.kind === 'aliyun' ? '' : ' hidden');
      $('channel-openai').className = 'channel-body' + (state.kind === 'openai' ? '' : ' hidden');
      if ($('channel-bfl')) $('channel-bfl').className = 'channel-body' + (state.kind === 'bfl' ? '' : ' hidden');
      // 百炼能测（/api/v1/models），但返回的是分页目录而不是 OpenAI 的 data[]，
      // 探针还没接这一支。与其留一个点了必挨骂的按钮，不如先禁用并说清原因。
      var probe = $('test-channel');
      if (probe) {
        probe.disabled = state.locked || state.kind === 'aliyun';
        probe.title = state.kind === 'aliyun'
          ? '百炼的列表格式不同，这一步还没接；先保存，再看生成时的真实报错'
          : (state.kind === 'bfl'
            ? '用一个只读请求验证 Key（BFL 走 /credits，顺带看余额），不会保存、不出图'
            : '用一个只读请求验证地址和 Key（普通渠道走 /models，Vertex 走 generateContent 探针），不会保存');
      }
    }

    function label(view) {
      if (view.kind === 'bfl') {
        var bfl = view.bfl || {};
        // 模型留空时服务端会用 flux-pro-1.1，这里显示同一件事，免得出现
        // 「顶部写 FLUX · 未填模型，其实已经在用默认模型出图」的自相矛盾。
        return channelName(bfl, DEFAULT_BFL_NAME) + ' · ' + (bfl.model || 'flux-pro-1.1（默认）');
      }
      if (view.kind !== 'openai') return '百炼';
      // 只说「哪个渠道、哪个模型」。地址在上面的输入框里就摆着，再念一遍是噪音。
      var model = view.openai && view.openai.model ? view.openai.model : '未填模型';
      return channelName(view.openai) + ' · ' + model;
    }

    // 顶部分段按钮的文案跟着「显示名称」走：用户刚在上面填完名字并保存，
    // 回头看到的还是「第三方 API」，会以为没存上。固定类别（OpenAI 兼容协议）
    // 收进 title，鼠标停一下仍然能看出这是哪条通道。
    function syncTabName(openai) {
      var tab = $('channel-openai-tab');
      if (!tab) return;
      var name = channelName(openai);
      tab.textContent = name;
      tab.title = name === DEFAULT_CHANNEL_NAME
        ? 'OpenAI 兼容协议的第三方渠道'
        : name + '（OpenAI 兼容协议的第三方渠道）';
    }

    function syncBflTabName(bfl) {
      var tab = $('channel-bfl-tab');
      if (!tab) return;
      var name = channelName(bfl, DEFAULT_BFL_NAME);
      tab.textContent = name;
      tab.title = name === DEFAULT_BFL_NAME
        ? 'Black Forest Labs（FLUX）：扩图与选区编辑走专用端点'
        : name + '（Black Forest Labs / FLUX）';
    }

    function apply(view) {
      var aliyun = view.aliyun || {};
      var openai = view.openai || {};
      state.locked = Boolean(view.locked);
      selectTab(view.kind);

      $('workspace-id').value = aliyun.workspaceId || '';
      $('api-key').value = '';
      $('api-key').placeholder = aliyun.hasKey ? '已保存，留空则沿用' : '输入后保存，不在面板回显';

      $('base-url').value = openai.baseUrl || '';
      $('channel-name').value = openai.name || '';
      syncTabName(openai);
      var savedModel = openai.model || '';
      state.vertex = openai.protocol === 'vertex' || isVertexAddress(openai.baseUrl);
      state.picked = false;
      renderModels(savedModel, state.vertex);
      // 全新安装（从没保存过模型）时，尺寸模式也跟着推荐模型走。否则会出现
      // 「下拉选的是 Gemini、模式却是像素」这种界面上看不出问题的错配。
      var sizeMode = openai.sizeMode === 'tier' ? 'tier' : 'pixels';
      $('openai-size-mode').value = savedModel ? sizeMode : (state.vertex ? VERTEX_MODELS[0].sizeMode : MODELS[0].sizeMode);
      $('openai-key').value = '';
      $('openai-key').placeholder = openai.hasKey ? '已保存，留空则沿用' : '输入后保存，不在面板回显';

      // BFL 那块永远是「回填已存的、没存过就摆默认值」。地址留空等于官方域名，
      // 所以输入框的 placeholder 直接写出来，用户不必去猜该不该填。
      //
      // 这里逐个判空而不是直接赋值：CEP / UXP / 预览三份 HTML 各写一遍，
      // 漏一个 id 就整块崩掉是最难查的故障——它会连带让「正在使用哪条渠道」也不显示。
      var bfl = view.bfl || {};
      if ($('bfl-base-url')) $('bfl-base-url').value = bfl.baseUrl && bfl.baseUrl !== 'https://api.bfl.ai' ? bfl.baseUrl : '';
      if ($('bfl-name')) $('bfl-name').value = bfl.name || '';
      syncBflTabName(bfl);
      renderBflModels(bfl.model || '');
      if ($('bfl-key')) {
        $('bfl-key').value = '';
        $('bfl-key').placeholder = bfl.hasKey ? '已保存，留空则沿用' : 'bfl_ 开头，输入后保存';
      }

      var lock = $('channel-lock');
      lock.className = state.locked ? 'lock' : 'lock hidden';
      lock.textContent = view.lockedNote || '由配置文件锁定';

      // 锁定时整块置灰：让用户一眼看出「这里改了不会生效」，比保存后才报错友好。
      for (var i = 0; i < CONTROLS.length; i++) {
        var node = $(CONTROLS[i]);
        if (node) node.disabled = state.locked;
      }
      $('channel-aliyun-tab').disabled = state.locked;
      $('channel-openai-tab').disabled = state.locked;
      if ($('channel-bfl-tab')) $('channel-bfl-tab').disabled = state.locked;
      return view;
    }

    function load() {
      return service.channel().then(function (view) {
        apply(view);
        // 这里的「正在使用」指的是已经保存生效的那套，未必等于当前打开的标签页——
        // 用户可能正切到另一边准备改。用「正在使用」而不是「当前渠道」，这两种状态才分得开。
        setStatus('正在使用 ' + label(view) + '。');
        return view;
      }, function (error) {
        setStatus(error.message || '无法读取渠道设置。', 'error');
      });
    }

    function payload() {
      if (state.kind === 'bfl') {
        var pickedBfl = $('bfl-model').value;
        var bflModel = pickedBfl === CUSTOM ? $('bfl-model-custom').value.trim() : String(pickedBfl || '').trim();
        return {
          kind: 'bfl',
          // 留空就交给服务端回落官方域名；不在这里补默认值，
          // 否则用户以后再改默认域名时，这里还留着一份写死的副本。
          baseUrl: $('bfl-base-url').value.trim(),
          apiKey: $('bfl-key').value.trim(),
          model: bflModel,
          name: $('bfl-name').value.trim()
        };
      }
      if (state.kind === 'openai') {
        var picked = $('openai-model').value;
        var model = picked === CUSTOM ? $('openai-model-custom').value.trim() : String(picked || '').trim();
        return {
          kind: 'openai',
          baseUrl: $('base-url').value.trim(),
          apiKey: $('openai-key').value.trim(),
          model: model,
          name: $('channel-name').value.trim(),
          sizeMode: $('openai-size-mode').value
        };
      }
      return {
        kind: 'aliyun',
        workspaceId: $('workspace-id').value.trim(),
        apiKey: $('api-key').value.trim()
      };
    }

    // 测试结果分三种，文案必须能区分开：
    //   命中  → 地址、Key、模型名都对得上
    //   未命中→ 地址和 Key 是好的，只是列表里没这个模型（多半拼错，或渠道没上这个模型）
    //   无列表→ 渠道没有 /models，只能证明地址和 Key 通，模型名核不了
    // 混成一句「连通成功」会让用户带着错模型名去生成，然后卡在上传完才失败。
    // 还有一类不进这里：地址路径写错（404，但渠道在正文里说明了该用哪个路径）——
    // 服务端直接抛错，由下面的 error 分支原样显示。那种情况必须显示成失败。
    // 握手耗时是给「今晚这条线能不能用」做判断的：fetch 只回一个总数，
    // 分不清是 Google 在排队还是本机线路慢。实测出现过 DNS 1.4s、TLS 3.3s 的线路，
    // 那种数字一摆出来，用户就知道该不该拿它去出 4K 图。
    // 规范 5.3：数字带单位，超过 1 秒换成秒——「TLS 3330ms」要让人在脑子里除一次，
    // 「TLS 3.3 秒」不用。总耗时和分段耗时都用它，免得同一句里两种量纲。
    function duration(v) {
      return v >= 1000 ? (v / 1000).toFixed(1) + ' 秒' : v + 'ms';
    }

    function describeHandshake(h) {
      if (!h) return '';
      if (h.code) return '；但单独测握手失败（' + h.code + '）';
      var parts = [];
      if (typeof h.dnsMs === 'number') parts.push('DNS ' + duration(h.dnsMs));
      if (typeof h.tcpMs === 'number') parts.push('TCP ' + duration(h.tcpMs));
      if (typeof h.tlsMs === 'number') parts.push('TLS ' + duration(h.tlsMs));
      if (!parts.length) return '';
      var slow = (typeof h.tlsMs === 'number' && h.tlsMs >= 800) || (typeof h.dnsMs === 'number' && h.dnsMs >= 600);
      return '；建连 ' + parts.join(' · ') + (slow ? '（线路偏慢，出图会先卡在建连上）' : '');
    }

    function describeTest(result) {
      if (!result || result.ok !== true) return { text: '测试失败。', tone: 'error' };
      var ms = result.latencyMs ? '，' + duration(result.latencyMs) : '';
      var hand = describeHandshake(result.handshake);
      // Vertex Express Mode 没有模型列表，验的是「一条最小的 generateContent 能不能通」。
      // 这跟列表命中不是一回事，文案必须分开写，否则用户会以为模型名也核过了。
      if (result.probe === 'vertex-generate-content') {
        return { text: '连通正常（Vertex）：探针 ' + (result.probeModel || 'gemini-3.5-flash-lite') + ' 返回 HTTP ' + result.status + ms + hand + '。地址和 Key 都对。Express Mode 不提供模型列表，模型名由内置预设提供，这里核不了；能不能出图还要真跑一次。', tone: 'ok' };
      }
      // BFL 的探针打 /credits，顺手把余额带回来了。余额这件事在这里说清楚最有用：
      // 它用 402 表示没钱，等到生成时才看见 402，用户会以为是 Key 或模型的问题。
      if (result.probe === 'bfl-credits') {
        var credits = typeof result.credits === 'number' ? result.credits : null;
        if (credits !== null && credits <= 0) {
          return { text: 'Key 有效' + ms + hand + '，但余额是 0 credits：现在能连上、生成会被 402 拒掉。去 api.bfl.ai 充值后再试。', tone: 'warn' };
        }
        var money = credits !== null ? '，余额 ' + credits + ' credits' : '';
        return { text: '连通正常（BFL）：Key 有效' + money + ms + hand + '。BFL 不提供模型列表，模型名核不了；扩图和选区编辑走各自的固定端点，不受这里选的模型影响。', tone: 'ok' };
      }
      if (result.modelFound === true) {
        // 别让「连通正常」听起来像「可以出图了」：这一步只证明渠道认得这个名字。
        return { text: '连通正常：Key 有效，列表里有「' + result.model + '」' + ms + hand + '。这只说明渠道认得这个名字，余额和出图权限还得真跑一次才知道。', tone: 'ok' };
      }
      if (result.modelFound === false) {
        var extra = result.similar && result.similar.length ? ' 渠道里的图像模型：' + result.similar.join('、') + '。' : '';
        return { text: '地址和 Key 是好的，但列表里没有「' + result.model + '」（共 ' + result.modelCount + ' 个模型）。' + extra, tone: 'warn' };
      }
      return { text: '地址和 Key 能连上' + ms + hand + '，但渠道没有模型列表接口，模型名没法核对。', tone: 'warn' };
    }

    // 「测试」只读不写：不保存、不动凭据库，所以渠道被配置文件锁定时也允许点
    // （锁定只是不让改，验证当前这套能不能用反而更需要它）。
    function test() {
      if (state.kind === 'aliyun') {
        setTestStatus('百炼的连通测试还没接（列表格式不同）。先保存，再看生成时的真实报错。', 'warn');
        return Promise.resolve(null);
      }
      if (!service.testChannel) {
        setTestStatus('当前客户端不支持连通测试。', 'error');
        return Promise.resolve(null);
      }
      var bfl = state.kind === 'bfl';
      var data = payload();
      // BFL 的地址和模型都能留空（官方域名 + 内置默认模型），没必要拿它们拦住测试：
      // 这两项在 BFL 上不存在「填错就静默失效」，先验 Key 才有意义。
      if (!data.baseUrl && !bfl) {
        setTestStatus('请先填写服务地址。', 'error');
        return Promise.resolve(null);
      }
      // Vertex 的探针用内置模型，跟下拉里选了什么无关，所以这里不拦「没选模型」。
      if (!data.model && !bfl && !isVertexAddress(data.baseUrl)) {
        setTestStatus('请先选择模型。', 'error');
        return Promise.resolve(null);
      }
      setTestStatus('正在测试…');
      var button = $('test-channel');
      if (button) button.disabled = true;
      return service.testChannel(data).then(function (result) {
        var info = describeTest(result);
        setTestStatus(info.text, info.tone);
        return result;
      }, function (error) {
        setTestStatus(error.message || '测试失败。', 'error');
        return null;
      }).then(function (value) {
        if (button) button.disabled = state.locked;
        return value;
      });
    }

    function save() {
      if (state.locked) {
        setStatus('渠道由配置文件锁定，请修改 openai.env 后重启服务。', 'error');
        return Promise.resolve(null);
      }
      setStatus('正在保存…');
      return service.saveChannel(payload()).then(function (view) {
        apply(view);
        setStatus('已保存，下一次生成就会使用「' + label(view) + '」。', 'ok');
        return view;
      }, function (error) {
        setStatus(error.message || '保存失败。', 'error');
        return null;
      });
    }

    function bind() {
      $('channel-aliyun-tab').onclick = function () { selectTab('aliyun'); };
      $('channel-openai-tab').onclick = function () { selectTab('openai'); };
      if ($('channel-bfl-tab')) $('channel-bfl-tab').onclick = function () { selectTab('bfl'); };
      $('save-channel').onclick = save;
      if ($('openai-model')) $('openai-model').onchange = onModelChange;
      if ($('bfl-model')) $('bfl-model').onchange = onBflModelChange;
      if ($('base-url')) $('base-url').onchange = onBaseUrlChange;
      if ($('test-channel')) $('test-channel').onclick = test;
    }

    return { bind: bind, load: load, save: save, test: test, apply: apply, state: state, models: MODELS, vertexModels: VERTEX_MODELS, bflModels: BFL_MODELS };
  }

  // 顶部渠道条要显示的那句话。抽成纯函数放这里，是因为它有两个调用方
  // （CEP 与 UXP 各一份 main.js），写在各自入口里必然会分叉——就像当年 panel.js
  // 合并之前那样，同一个状态在两端显示出不同结论。
  //
  // 返回 tone：ok=可用，warn=连上了但没配全，error=没连上。
  // label 是固定类别（第三方 API / 百炼 / 本地服务），detail 是变化的那半截
  // （模型名、或下一步该干什么）。面板把 detail 画成胶囊、用 tone 上色，
  // 所以这一拆分必须和 CSS 的 `.provider-chip` 对齐。text 保留给 tooltip 与老调用方。
  function summary(label, detail, tone) {
    return { label: label, detail: detail, text: label + ' · ' + detail, tone: tone };
  }
  function providerSummary(view) {
    if (!view) return summary('本地服务未连接', '填写连接码', 'error');
    var suffix = view.locked ? '（已锁定）' : '';
    if (view.kind === 'bfl') {
      var bfl = view.bfl || {};
      var bflLabel = channelName(bfl, DEFAULT_BFL_NAME);
      // 地址在 BFL 上没有必须填的说法，所以这里只卡 Key。
      if (!bfl.hasKey) return summary(bflLabel, '未填 API Key', 'warn');
      // 模型留空 = 用内置默认。显示出来，别让顶部写着「未填模型」却已经在出图。
      return summary(bflLabel, (bfl.model || 'flux-pro-1.1') + suffix, 'ok');
    }
    if (view.kind === 'openai') {
      var openai = view.openai || {};
      // 用户给渠道起的名字（设置页「显示名称」）。留空就回落默认称呼，
      // 回落规则统一在 channelName() 里，设置页按钮和这里读的是同一个函数。
      var label = channelName(openai);
      if (!openai.baseUrl) return summary(label, '未填服务地址', 'warn');
      if (!openai.hasKey) return summary(label, '未填 API Key', 'warn');
      if (!openai.model) return summary(label, '未填模型', 'warn');
      return summary(label, openai.model + suffix, 'ok');
    }
    var aliyun = view.aliyun || {};
    if (!aliyun.hasKey) return summary('百炼', '未填 API Key', 'warn');
    if (!aliyun.workspaceId) return summary('百炼', '未填业务空间', 'warn');
    return summary('百炼', aliyun.workspaceId + suffix, 'ok');
  }

  return { createChannelView: createChannelView, providerSummary: providerSummary };
}));
