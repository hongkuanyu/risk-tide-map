/* global window */
/*
 * 全国城市墨迹 · 城市数据
 *
 * 数据状态（沿用项目既有规范，务必如实标注）：
 *   coordinate  —— 城市中心近似坐标，取常用公开值，保留 3 位小数，
 *                  仅用于"墨迹落点"，不是精确行政中心点。
 *   verified    —— 全部为 false：未经逐条比对，不得当作精确地理数据。
 *   tier        —— 1 = 主要枢纽/省会，用于地图上标签的视觉权重。
 *
 * 本文件不包含任何"行程时间"数据：行程时间由 js/nation-risk.js
 * 依据直线距离与速度假设推算，属于示意模型，不是真实时刻表。
 */
(function (global) {
  'use strict';

  const source = '城市中心近似坐标 · 常用公开值 · 未逐条核验';

  const cities = [
    { id: 'wuxi',      name: '无锡',   province: '江苏', tier: 2, coordinate: [120.312, 31.491] },
    { id: 'nanjing',   name: '南京',   province: '江苏', tier: 1, coordinate: [118.797, 32.060] },
    { id: 'suzhou',    name: '苏州',   province: '江苏', tier: 2, coordinate: [120.585, 31.299] },
    { id: 'changzhou', name: '常州',   province: '江苏', tier: 2, coordinate: [119.974, 31.811] },
    { id: 'nantong',   name: '南通',   province: '江苏', tier: 2, coordinate: [120.894, 31.980] },
    { id: 'xuzhou',    name: '徐州',   province: '江苏', tier: 2, coordinate: [117.284, 34.206] },
    { id: 'hangzhou',  name: '杭州',   province: '浙江', tier: 1, coordinate: [120.155, 30.274] },
    { id: 'ningbo',    name: '宁波',   province: '浙江', tier: 2, coordinate: [121.550, 29.875] },
    { id: 'wenzhou',   name: '温州',   province: '浙江', tier: 2, coordinate: [120.699, 27.994] },
    { id: 'hefei',     name: '合肥',   province: '安徽', tier: 1, coordinate: [117.227, 31.821] },
    { id: 'wuhu',      name: '芜湖',   province: '安徽', tier: 2, coordinate: [118.433, 31.353] },
    { id: 'shanghai',  name: '上海',   province: '上海', tier: 1, coordinate: [121.474, 31.230] },
    { id: 'beijing',   name: '北京',   province: '北京', tier: 1, coordinate: [116.407, 39.904] },
    { id: 'tianjin',   name: '天津',   province: '天津', tier: 1, coordinate: [117.191, 39.084] },
    { id: 'jinan',     name: '济南',   province: '山东', tier: 1, coordinate: [117.121, 36.651] },
    { id: 'qingdao',   name: '青岛',   province: '山东', tier: 2, coordinate: [120.383, 36.067] },
    { id: 'zhengzhou', name: '郑州',   province: '河南', tier: 1, coordinate: [113.625, 34.747] },
    { id: 'wuhan',     name: '武汉',   province: '湖北', tier: 1, coordinate: [114.305, 30.593] },
    { id: 'changsha',  name: '长沙',   province: '湖南', tier: 1, coordinate: [112.939, 28.228] },
    { id: 'nanchang',  name: '南昌',   province: '江西', tier: 1, coordinate: [115.892, 28.676] },
    { id: 'fuzhou',    name: '福州',   province: '福建', tier: 1, coordinate: [119.296, 26.074] },
    { id: 'xiamen',    name: '厦门',   province: '福建', tier: 2, coordinate: [118.089, 24.479] },
    { id: 'guangzhou', name: '广州',   province: '广东', tier: 1, coordinate: [113.264, 23.129] },
    { id: 'shenzhen',  name: '深圳',   province: '广东', tier: 1, coordinate: [114.058, 22.543] },
    { id: 'zhuhai',    name: '珠海',   province: '广东', tier: 2, coordinate: [113.553, 22.271] },
    { id: 'nanning',   name: '南宁',   province: '广西', tier: 1, coordinate: [108.320, 22.824] },
    { id: 'guilin',    name: '桂林',   province: '广西', tier: 2, coordinate: [110.290, 25.274] },
    { id: 'haikou',    name: '海口',   province: '海南', tier: 2, coordinate: [110.199, 20.044] },
    { id: 'chongqing', name: '重庆',   province: '重庆', tier: 1, coordinate: [106.551, 29.563] },
    { id: 'chengdu',   name: '成都',   province: '四川', tier: 1, coordinate: [104.066, 30.572] },
    { id: 'guiyang',   name: '贵阳',   province: '贵州', tier: 1, coordinate: [106.630, 26.647] },
    { id: 'kunming',   name: '昆明',   province: '云南', tier: 1, coordinate: [102.833, 24.880] },
    { id: 'xian',      name: '西安',   province: '陕西', tier: 1, coordinate: [108.940, 34.341] },
    { id: 'lanzhou',   name: '兰州',   province: '甘肃', tier: 1, coordinate: [103.834, 36.061] },
    { id: 'xining',    name: '西宁',   province: '青海', tier: 2, coordinate: [101.778, 36.617] },
    { id: 'yinchuan',  name: '银川',   province: '宁夏', tier: 2, coordinate: [106.231, 38.487] },
    { id: 'hohhot',    name: '呼和浩特', province: '内蒙古', tier: 2, coordinate: [111.751, 40.842] },
    { id: 'urumqi',    name: '乌鲁木齐', province: '新疆', tier: 1, coordinate: [87.617, 43.792] },
    { id: 'lhasa',     name: '拉萨',   province: '西藏', tier: 2, coordinate: [91.140, 29.645] },
    { id: 'harbin',    name: '哈尔滨', province: '黑龙江', tier: 1, coordinate: [126.535, 45.803] },
    { id: 'changchun', name: '长春',   province: '吉林', tier: 2, coordinate: [125.324, 43.887] },
    { id: 'shenyang',  name: '沈阳',   province: '辽宁', tier: 1, coordinate: [123.429, 41.796] },
    { id: 'dalian',    name: '大连',   province: '辽宁', tier: 2, coordinate: [121.614, 38.914] }
  ];

  cities.forEach(function (city) { city.source = source; city.verified = false; });

  global.RiskTideCities = { source: source, list: cities };
})(window);