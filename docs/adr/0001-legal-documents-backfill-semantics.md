# legal_documents 回填语义：只增不删，允许 UPDATE

flk 的 laws 表有「不动历史行」约束，legal_documents 共用同一 adapter/loader 体系，容易被默认套用同一约束；但存量回填（监察法规补正文、党内法规补覆盖）必须能 UPDATE 既有行的 content/status，否则 93% 缺正文的存量永远修不回来。决策：legal_documents 的回填允许按 source_id UPDATE 既有行（content_hash 变更即变更条目），但主键不变、只增不删；条目退出源侧目录一律走状态字段而非删行，幂等仍以 content_hash 判定，重复装载同一快照不产生重复行。

## Considered Options

- 沿用「不动历史行」——被否：正文缺口无法清偿，回填失去意义。
- 删除性收编（源侧消失即删行）——被否：政府站点目录抖动会造成数据意外消失。
