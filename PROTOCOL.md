# rob-20 协议规范 v2 — Robinhood Chain 铭文平台

rob-20 是 Robinhood Chain（链 ID 4663）上的 calldata 铭文协议。铭文本体是交易
input data 中的 UTF-8 文本；除守门/市场两个基础设施合约外链上不存在代币，
所有余额由按本规范实现的索引器从链上数据确定性推导。本文件是记账规则的唯一权威。

系统合约：
- **InscriptionHub**：tick 注册与 mint 守门。无 owner、无许可、参数部署后不可改。
- **InscriptionMarket**：挂单托管与成交。买卖双边各收成交价 5% 平台费（合约常量）。

## 通用规则

1. 只有**执行成功**（receipt status = 1）的交易/事件才会被索引；回退的交易一律忽略。
2. 铭文文本必须与规范形式**逐字节一致**：ASCII、无空格、无换行、键顺序固定。
3. 同一区块内按 transactionIndex（交易内按日志顺序）结算。
4. tick 必须匹配 `^[a-z0-9]{1,8}$`（小写字母与数字，1–8 字节），全局唯一，先注册先得。
5. 数量/价格均为十进制整数字符串，无前导零、无小数点。余额无小数位。

## op: deploy — 注册新 tick

调用 `InscriptionHub.deployTick(tick, maxMints, amountPerMint, walletLimit, mintPrice)`
（selector `0x0925e6b6`）。约束（合约强制）：tick 规范且未被注册；
`1 ≤ maxMints ≤ 1e9`；`1 ≤ amountPerMint ≤ 1e15`；`1 ≤ walletLimit ≤ maxMints`；
`mintPrice ≤ 100 ether`（0 = 免费 mint）。调用者成为该 tick 的部署者（mint 费收款人）。

**索引规则**：`Deployed` 事件 → 注册 tick 及其参数。

## op: mint

用户（EOA 直接发起，`msg.sender == tx.origin`）向 **InscriptionHub** 发送交易，
金额必须恰好等于该 tick 的 `mintPrice`，calldata 为规范铭文：

```
data:,{"p":"rob-20","op":"mint","tick":"<tick>","amt":"<amountPerMint>"}
```

`<amt>` 必须等于该 tick 注册的 `amountPerMint`。Hub 在链上解析并强制执行全部
规则（文本规范、金额、每钱包上限、总量），任一不满足整笔回退——用户不会为无效
mint 损失费用。mint 费记入部署者名下，由部署者调用 `withdrawFees()` 自提。

**索引规则**：`Inscribed(tickHash, minter, n)` 事件 →
`balances[tick][minter] += amountPerMint`。索引器独立复核 `n ≤ maxMints`，
发现超发视为严重故障并停机。

## op: transfer — 点对点转账

持有人向**接收方地址**发送交易（金额任意，通常 0），calldata：

```
data:,{"p":"rob-20","op":"transfer","tick":"<tick>","amt":"<N>"}
```

`<N>` 匹配 `^[1-9][0-9]{0,29}$`。**索引规则**（交易成功才结算）：
tick 已注册且 `balances[tick][from] ≥ N` → 划转 N 给 `to`；否则无效忽略。
`to` 为空（创建合约）忽略；转给自己有效但无净变动。发往 Hub/Market 的 transfer
文本会被合约回退，故余额不可能落在系统合约上。

## op: list — 市场挂单（托管）

卖家向 **InscriptionMarket** 发送 0 ETH 交易，calldata：

```
data:,{"p":"rob-20","op":"list","tick":"<tick>","amt":"<N>","price":"<wei>"}
```

`<N>` 同 transfer；`<price>` 匹配 `^[1-9][0-9]{0,29}$`（单位 wei，整单一口价）。
市场合约解析并记录 Listing（id 自增，状态 Pending），发出 `Listed` 事件。

**索引规则**：`Listed(id, seller, tickHash, tick, amt, price)` →
若 `balances[tick][seller] ≥ N`：扣除 N 进入 `escrow[id]`，托管**有效**；
否则托管**无效**（永不确认，链上 Listing 沦为死单）。

## 市场状态机（合约 + 索引器）

- `confirm(id)`（`0xba0179b5`，仅 operator）：Pending → Active。平台 oracle 只对
  托管有效的挂单调用 confirm——买家只能购买 Active 挂单，这是买家资金安全的
  信任锚（与经典铭文市场一致的平台托管模型，需明示用户）。
- `buy(id)`（`0xd96a094a`，payable）：状态必须 Active；
  `msg.value == price + floor(price*5%)`（买家承担 5%）；
  卖家即时收到 `price - floor(price*5%)`（卖家承担 5%；打款失败转入待领）；
  双边费用累积在合约内，owner 可提。发出 `Bought(id, buyer)`。
  **索引规则**：托管有效 → `escrow[id]` 划给买家。
- `cancel(id)`（`0x40e58ee5`，仅卖家，Pending/Active 可撤）：发出 `Cancelled(id)`。
  **索引规则**：托管有效 → `escrow[id]` 退回卖家。
- `sweep(uint256[] ids)`（`0x98b02275`，payable）：一笔买入多个 Active 挂单，跳过
  已成交/撤单/超预算的，多付部分退回买家；全无可买则回退。每个成交等价于一次
  `buy`，索引规则相同（每个 `Bought` 事件独立结算）。

## 买单（双边盘：op deploy 侧的对称流程）

买单由**买家链上托管 ETH**、**卖家发 accept 铭文交割**、**operator 结算**三步组成，
与挂单对称（挂单是卖家托管铭文、买家 buy 结算）。

- `placeBid(tick, amt, price)`（`0xc7df5882`，payable）：买家挂买单，
  `msg.value == price + floor(price*5%)`（买家 5% 一并托管在合约里）。
  发出 `BidPlaced(id, bidder, tickHash, tick, amt, price)`。**索引规则**：记录买单
  （状态 Open）。买家 ETH 在链上安全托管，随时可 `cancelBid` 全额退回。
- **op: accept** — 卖家向**买家（bidder）地址**发送 0 ETH 交易交割某买单
  （**不可发给 Market**——会被 fallback 当 list 解析而回退）：
  ```
  data:,{"p":"rob-20","op":"accept","tick":"<tick>","bid":"<id>"}
  ```
  这是一条纯 calldata 信号铭文（索引器按 calldata 扫描，类似 transfer），不调用
  合约。**索引规则**（交易成功）：买单 Open、tick 匹配、`balances[tick][seller] ≥ amt`
  且该买单尚无待结算卖家 → 扣除卖家 amt 进入 `bidEscrow[id]`（托管有效），记录
  待结算卖家 = seller；否则忽略（无效 accept）。同一买单多卖家竞争时，先到先得。
- `settleBid(id, seller)`（`0xe55df556`，仅 operator）：Open → Filled；付卖家
  `price - 5%`，两侧 5% 入平台费。发出 `BidFilled(id, seller)`。平台 oracle 只对
  “有有效 accept 托管”的买单、以对应 seller 结算。**索引规则**：`bidEscrow[id]`
  划给买家（bidder）；买单完成。
- `cancelBid(id)`（`0x9703ef35`，仅买家，Open 可撤）：退回买家托管 ETH，发出
  `BidCancelled(id)`。**索引规则**：若已有 accept 托管 → 退回给该卖家。

买家资金安全由**链上托管**保证（不依赖 oracle）；卖家交割后由 `BidFilled` 事件
原子完成“付款 + 账本划转”，若 oracle 不结算则卖家 accept 托管可随买单撤销退回，
卖家不受损。

## 索引器实现要求

- 从部署区块起逐块扫描，落后链头 `confirmations`（默认 10）个区块。
- 合约操作以**成功交易的事件日志**为准；transfer 以 calldata 扫描 + receipt 复核为准。
- 状态必须可从零重放：删除本地状态重扫必须得到逐字节相同的结果。
- 索引器即记账权威，须持续运行并备份 `state.json` 与 `events.jsonl`。
