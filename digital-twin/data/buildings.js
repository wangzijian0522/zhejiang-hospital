// ============================================================
// 医院白膜建筑配置（可编辑）
// 数据来源：
//   - 医院总平1.jpg（5898x3035px，比例尺约 10.5px/m，2016 总平面图）
//   - 医院建筑平面/*.dwg 提取的标高/层数/电梯文本
// 说明：
//   - parts[].px = 总平图上的外接框 [x1,y1,x2,y2]（像素，原点在左上角）
//   - floors = 层数，height = 高度(m)。层数来自图片楼层标注；高度
//     优先取 DWG 标高（53.100 / 54.40 / 43.750 / 高度18000），
//     否则按 3.8m/层 估算（DWG 显示部分楼层 3.6~4.8m 不等）。
//   - certainty 0~1 为识别可信度（0.2=猜测，0.8=有交叉验证）
// ============================================================

export const IMG = { w: 5898, h: 3035, pxPerM: 10.5 };

export const BUILDINGS = [
  {
    id: 'b1',
    name: '1号病房综合楼',
    short: '1号楼',
    info: '地上56686㎡ / 地下10963㎡（2层地下室），±0.000=黄海4.800m',
    elevator: {
      count: 2,
      detail: '一层2部电梯、4个电梯厅；底坑标高 -1.800（1F）、-11.500（地下2层）；标准层2个电梯厅',
    },
    certainty: 0.7,
    source: '总平图标注（22F/25F椭圆塔楼/24F/4F/6F/5F/3F）+ 1号楼DWG',
    parts: [
      { px: [1437, 957, 1895, 1243], floors: 25, height: 95, note: '椭圆塔楼 25F' },
      { px: [1965, 943, 2489, 1375], floors: 22, height: 84, note: '主体 22F/24F' },
      { px: [1370, 1202, 2066, 1433], floors: 4, height: 16, note: '裙楼' },
      { px: [1419, 1367, 2078, 1550], floors: 4, height: 16, note: '裙楼' },
      { px: [1857, 954, 2102, 1206], floors: 4, height: 16, note: '裙楼' },
      { px: [2166, 894, 2444, 1082], floors: 4, height: 16, note: '裙楼' },
      { px: [1919, 789, 2146, 911], floors: 3, height: 12, note: '裙楼' },
      { px: [990, 844, 1343, 1049], floors: 3, height: 12, note: '裙楼（可能为8号楼，待确认）' },
      { px: [1092, 975, 1320, 1169], floors: 3, height: 12, note: '裙楼（可能为辅助用房，待确认）' },
    ],
  },
  {
    id: 'b2',
    name: '门急诊楼',
    short: '门急诊楼',
    info: '地上26516㎡ / 地下8944㎡；6F裙房+14F塔楼；地下车库252车位',
    elevator: {
      count: 4,
      detail: '电梯1/2/3/4号（编号电梯）；一层平面共6处电梯标注',
    },
    certainty: 0.8,
    source: '总平图（6F、双内庭院、门诊/急诊入口）+ 2号楼平面.dwg + 竣工图立面标高 NIVEL 54.40/51.90/42.50',
    parts: [
      { px: [2347, 1649, 3177, 2368], floors: 6, height: 24, note: '裙房（两个内庭院）' },
      { px: [2830, 1710, 3120, 1960], floors: 14, height: 50, note: '塔楼（立面标高54.40黄海≈相对49.6m）' },
    ],
  },
  {
    id: 'b5',
    name: '5号楼',
    short: '5号楼',
    info: '地上19863㎡ / 地下1532㎡',
    elevator: { count: 6, detail: '≥6个电梯厅' },
    certainty: 0.8,
    source: '总平图15F标注（面积交叉验证：15F×1263㎡≈18945㎡）',
    parts: [
      { px: [2628, 714, 3041, 1202], floors: 15, height: 57, note: '主体 15F' },
      { px: [2667, 1310, 2993, 1606], floors: 4, height: 16, note: '扩建部分 4F（5号楼辅）' },
    ],
  },
  {
    id: 'b3',
    name: '3号楼（放射科）',
    short: '3号楼',
    info: '放射科',
    elevator: { count: 2, detail: '2~5处电梯标注' },
    certainty: 0.4,
    source: '总平图位置推断 + 3号楼及5号楼(辅)(放射科).dwg',
    parts: [{ px: [2959, 1274, 3274, 1556], floors: 4, height: 16, note: '位置待确认' }],
  },
  {
    id: 'b7',
    name: '7号楼（行政楼）',
    short: '7号楼',
    info: '总平图标3F；DWG中7号行政楼出现标高43.750（疑为更高建筑，待核实）',
    elevator: { count: 0, detail: '未见电梯标注' },
    certainty: 0.4,
    source: '总平图3F标注 + 7号行政楼DWG',
    parts: [
      { px: [3139, 1094, 3426, 1360], floors: 3, height: 12, note: '' },
      { px: [3357, 1094, 3656, 1392], floors: 2, height: 8, note: '连廊/裙房' },
    ],
  },
  {
    id: 'b2new',
    name: '拟建2号病房楼（2#楼/6号楼）',
    short: '2号病房楼',
    info: '地上23095㎡ / 地下6434㎡；原特需病房楼；地下车库149车位',
    elevator: {
      count: 3,
      detail: '客梯、医生梯、药梯/标本梯；电梯机房（梁面标高53.100）',
    },
    certainty: 0.7,
    source: '总平图12F/13F/14F标注（面积吻合：14F×1630㎡≈22820㎡）+ 6号楼平面.dwg（梁面标高53.100/52.650）',
    parts: [
      { px: [3667, 1015, 4095, 1449], floors: 14, height: 53, note: '主体 14F（梁面标高53.100）' },
      { px: [3627, 864, 4028, 1101], floors: 13, height: 49, note: '主体 13F' },
      { px: [3674, 1018, 3822, 1412], floors: 2, height: 8, note: '连廊' },
    ],
  },
  {
    id: 'b9',
    name: '9号楼',
    short: '9号楼',
    info: '3F',
    elevator: null,
    certainty: 0.4,
    source: '总平图',
    parts: [{ px: [3435, 409, 4031, 704], floors: 3, height: 12, note: '' }],
  },
  {
    id: 'skill',
    name: '技能培训中心',
    short: '技能培训中心',
    info: '3F',
    elevator: null,
    certainty: 0.4,
    source: '总平图',
    parts: [{ px: [4099, 348, 4688, 628], floors: 3, height: 12, note: '' }],
  },
  {
    id: 'dorm',
    name: '宿舍',
    short: '宿舍',
    info: '6F',
    elevator: null,
    certainty: 0.5,
    source: '总平图',
    parts: [{ px: [4390, 1594, 4901, 1811], floors: 6, height: 24, note: '' }],
  },
  {
    id: 'fever',
    name: '发热门诊',
    short: '发热门诊',
    info: '',
    elevator: { count: 1, detail: '无障碍电梯（残疾人电梯）' },
    certainty: 0.3,
    source: '总平图 + 发热门诊DWG',
    parts: [{ px: [2893, 613, 3311, 996], floors: 2, height: 9, note: '位置待确认' }],
  },
  {
    id: 'hbo',
    name: '高压氧舱',
    short: '高压氧舱',
    info: '1F',
    elevator: null,
    certainty: 0.4,
    source: '总平图',
    parts: [{ px: [4365, 1439, 4866, 1579], floors: 1, height: 5, note: '' }],
  },
  {
    id: 'kitchen',
    name: '厨房/洗衣',
    short: '厨房/洗衣',
    info: '3F',
    elevator: null,
    certainty: 0.4,
    source: '总平图',
    parts: [{ px: [3888, 1655, 4035, 1887], floors: 3, height: 12, note: '' }],
  },
  {
    id: 'canteen',
    name: '食堂',
    short: '食堂',
    info: '',
    elevator: { count: 1, detail: '电梯井道宽度标注（省人民医院食堂建筑施工图）' },
    certainty: 0.3,
    source: '食堂建筑施工图.dwg',
    parts: [{ px: [4303, 256, 4658, 427], floors: 2, height: 9, note: '位置待确认' }],
  },
  {
    id: 'er-annex',
    name: '门急诊附楼（急诊）',
    short: '急诊附楼',
    info: '',
    elevator: null,
    certainty: 0.4,
    source: '总平图',
    parts: [{ px: [2240, 1878, 2641, 2115], floors: 4, height: 16, note: '' }],
  },
  {
    id: 'er-hall',
    name: '门急诊入口大厅',
    short: '入口大厅',
    info: '',
    elevator: null,
    certainty: 0.3,
    source: '总平图',
    parts: [{ px: [2178, 1761, 2468, 1934], floors: 2, height: 10, note: '' }],
  },
  {
    id: 'aux-5',
    name: '辅助用房',
    short: '辅助用房',
    info: '',
    elevator: null,
    certainty: 0.2,
    source: '总平图',
    parts: [{ px: [2611, 604, 2933, 745], floors: 2, height: 8, note: '' }],
  },
  {
    id: 'aux-4',
    name: '辅助用房',
    short: '辅助用房',
    info: '',
    elevator: null,
    certainty: 0.2,
    source: '总平图',
    parts: [{ px: [3417, 552, 3625, 781], floors: 2, height: 8, note: '' }],
  },
  {
    id: 'aux-32',
    name: '未命名裙房',
    short: '未命名裙房',
    info: '位于1号楼与5号楼之间',
    elevator: null,
    certainty: 0.2,
    source: '总平图',
    parts: [{ px: [2193, 1350, 2705, 1742], floors: 4, height: 16, note: '位置待确认' }],
  },
];

// 未能定位到总平图斑块的建筑/设施（DWG 中有信息）
export const UNLOCATED = [
  '8号楼（DWG 标高43.750；无障碍电梯）',
  '采购维修楼（黄海标高4.8，静配中心改扩建）',
  '垃圾站',
  '消防登高扑救场地（地面区域）',
];

export const NOTES = [
  '层高按 3.8m/层 估算（6号楼DWG显示部分楼层3.6~4.8m不等）',
  '总图 ±0.000 = 黄海标高 4.800m',
  '图片编号（1/3/5/7/9号楼）与DWG编号（2号楼=门急诊楼、6号楼=2#楼塔楼）存在差异',
  '5号楼DWG"高度18000"疑为中庭/局部高度，非建筑总高（总平图标15F）',
  '电梯仅有文本级信息（数量/类型/底坑标高），无平面坐标（DWG未做几何解析）',
  '部分DWG为天正格式（"缺乏解释器天正图形看不见"），文字提取可能不完整',
];
