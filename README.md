# rob-20 — Robinhood Chain 铭文平台

Robinhood Chain 上的 calldata 铭文发射与交易平台。任何人都可以部署 tick（自定名字、
张数、每张数量、每钱包上限、mint 价格，可免费）、任何人都可以 mint、内置托管式
交易市场。铭文即交易 input data 里的 `data:,{...}` 原文，链上不发行代币，余额由
索引器按 [PROTOCOL.md](PROTOCOL.md) 记账。

## 架构

| 组件 | 职责 |
|---|---|
| [InscriptionHub.sol](src/InscriptionHub.sol) | tick 注册 + mint 守门。**链上直接解析铭文文本**，规则不符整笔回退；mint 费 100% 记给 tick 部署者（自提）。合约无 owner、无许可、不可升级。 |
| [InscriptionMarket.sol](src/InscriptionMarket.sol) | 托管市场：挂单=发 `op:"list"` 铭文给市场合约；平台 oracle 确认托管后方可购买；**买卖双边各收成交价 5%**（合约常量，不可改），归平台 owner。 |
| [indexer/indexer.mjs](indexer/indexer.mjs) | 记账权威：扫块结算 mint/transfer/市场事件，多 tick 账本，HTTP API + 前端站。零依赖 Node。 |
| [indexer/oracle.mjs](indexer/oracle.mjs) | 市场 oracle：自动 confirm 托管有效的挂单（调 `cast` 发交易）。 |
| [indexer/public/](indexer/public/) | 前端站：tick 列表 / 部署 / mint / 双边市场 / 我的资产。EIP-6963 多钱包（Rainbow/MetaMask/Coinbase…）。 |
| [e2e/e2e.mjs](e2e/e2e.mjs) | anvil 全链路联测（合约 + 索引器 + 市场生命周期 + 重放确定性）。 |

## 快速开始 / 环境变量

克隆（含子模块 forge-std / openzeppelin）：

```bash
git clone --recurse-submodules <repo-url> && cd rob-20
```

**含 key 的 RPC 端点不入库**，运行时用环境变量提供（仓库里的 `foundry.toml`、`indexer/config*.json` 均为占位符）：

| 变量 | 用途 |
|---|---|
| `RPC_URL` | indexer / oracle 连链用的 RPC（覆盖 config 里的 rpcUrl） |
| `ROBINHOOD_RPC` | foundry 的 `robinhood` 端点（部署 / 脚本） |

真实端点走上面的环境变量，或写进服务器上 gitignored 的 `config.production.json` / systemd `EnvironmentFile`。本地起索引器 + 前端：

```bash
RPC_URL=<你的RPC> CONFIG_PATH=indexer/config.json node indexer/indexer.mjs
# 打开 http://localhost:3000
```

## 测试

```bash
forge test        # 56 个合约测试 + 不变量测试（解析器边界 + 模糊测试）
node e2e/e2e.mjs  # 全链路端到端（含 100% mint 才可交易的门槛）
```

## 上线步骤（Robinhood Chain 主网，链 ID 4663）

```bash
# 1. 导入平台钱包（交互式，私钥不留历史）；建议 oracle 用单独的低权限钱包
cast wallet import platform --interactive
cast wallet import oracle --interactive

# 2. 部署 Hub + Market（OWNER/OPERATOR 不设则默认部署钱包）
OWNER=<平台收款地址> OPERATOR=<oracle地址> \
  forge script script/Deploy.s.sol --rpc-url robinhood --account platform --broadcast

# 3. Blockscout 开源验证
forge verify-contract <Hub地址> src/InscriptionHub.sol:InscriptionHub \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api
forge verify-contract <Market地址> src/InscriptionMarket.sol:InscriptionMarket \
  --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api \
  --constructor-args $(cast abi-encode "constructor(address,address)" <owner> <operator>)

# 4. 填 indexer/config.json（hubAddress / marketAddress / deployBlock），启动索引器 + oracle
#    ⚠️ deployBlock 必须 ≤ Hub 合约的部署区块号（部署交易所在区块，Blockscout 可查）。
#    设晚了会漏掉早期 Deployed/Inscribed 事件——索引器遇到未知 tick 的 mint 会主动停机报错，
#    但正确配置可以完全避免。
node indexer/indexer.mjs                       # 站点 http://localhost:3000
ORACLE_ACCOUNT=oracle node indexer/oracle.mjs

# 5. 发创世 tick（robin：21000 张 × 1000，每钱包 10 张，0.001 ETH/张）
cast send <Hub地址> "deployTick(string,uint64,uint128,uint32,uint128)" \
  robin 21000 1000 10 1000000000000000 --rpc-url robinhood --account platform
```

测试网演练：`--rpc-url robinhood_testnet`（链 ID 46630，水龙头
https://faucet.testnet.chain.robinhood.com ）。

## 用户操作速查

```bash
# mint（金额 = tick 的 mintPrice，data 为规范铭文原文）
cast send <Hub> --value 0.001ether --rpc-url robinhood --account me \
  $(cast from-utf8 'data:,{"p":"rob-20","op":"mint","tick":"robin","amt":"1000"}')

# 转账（发给接收人）
cast send <接收地址> --rpc-url robinhood --account me \
  $(cast from-utf8 'data:,{"p":"rob-20","op":"transfer","tick":"robin","amt":"500"}')

# 挂单（发给 Market，0 ETH；price 单位 wei，整单一口价）
cast send <Market> --rpc-url robinhood --account me \
  $(cast from-utf8 'data:,{"p":"rob-20","op":"list","tick":"robin","amt":"500","price":"50000000000000000"}')

# 购买单个挂单（实付 = price + floor(price×5%)，单位 wei；下例 price=5e16 → 实付 5.25e16）
cast send <Market> "buy(uint256)" <挂单id> --value 52500000000000000wei --rpc-url robinhood --account me

# 一键扫单：一笔买入多个挂单（最多 50 个）。被抢走/撤单的会自动跳过，多付部分退回。
# value 传所有挂单实付之和；前端「扫单买入」会自动按最低价凑单并算好金额。
cast send <Market> "sweep(uint256[])" "[<id1>,<id2>]" --value <总实付>wei --rpc-url robinhood --account me

# tick 部署者提取 mint 费 / 平台提取市场手续费
cast send <Hub> "withdrawFees()" --rpc-url robinhood --account me
cast send <Market> "withdrawFees(address)" <收款地址> --rpc-url robinhood --account platform
```

## 信任模型（须向用户明示）

- Hub 完全无许可：mint 规则链上强制，无效 mint 不花钱（只耗 gas）。
- 余额账本由平台索引器权威判定（经典铭文模式）；账本可开源重放验证——任何人
  跑 `indexer.mjs` 都会得到相同结果。
- 市场依赖平台 oracle 确认托管：买家只能买到托管已验证的挂单，但需信任平台
  不确认无效挂单（`confirm` 有链上事件，可事后审计）。
- 索引器必须持续运行并备份 `indexer/state.json` 与 `events.jsonl`。
- **只用普通钱包（EOA），不要用智能合约钱包（Safe/ERC-4337）**：mint 仅限 EOA 直接
  调用；更重要的是，铭文余额按"接收地址"记账，若把铭文**转账/挂单到一个合约地址**，
  该合约几乎不可能再发出合规的 transfer 铭文，余额将**永久冻结**。前端会拦截明显的
  合约接收地址，但请务必在社区文档中强调这一点。
- 索引器只监听 Hub/Market 两个合约地址的**事件日志**（`eth_getLogs`），因此无论 tick
  是直接部署还是经 Safe/工厂内部调用部署，都能被正确索引，不会漏记或崩溃。
- RPC：后端（索引器 / oracle / `--rpc-url robinhood` 部署）走 dRPC 负载均衡端点（含
  key，见 `indexer/config.json`、`foundry.toml`，**勿泄露到前端**）；前端钱包加链用
  公共 RPC，避免把 key 暴露给每个访客被盗刷。
