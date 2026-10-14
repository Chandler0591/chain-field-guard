// =============================================================================
// 链码可执行入口:library + entry 分离的 Go 惯例布局。
//
// 业务合约全部实现于上级目录的 agrichain 包(package agrichain,
// 便于脱离网络做 mock 单元测试),本文件只负责把它接入
// fabric-contract-api-go 的链码服务端:
//   - contractapi.NewChaincode 按函数名路由交易到 SmartContract 对应方法;
//   - Start() 阻塞运行,通过 peer 注入的环境变量
//     (CORE_CHAINCODE_ID_NAME / CORE_PEER_ADDRESS)接入 peer 的链码容器。
//
// 部署时链码源路径必须指向本目录(-ccp ../chaincode/agrichain/cmd):
// Fabric 打包整个模块源码后,以本包(package main)为 go build 目标,
// 才能产出 peer 启动链码容器所需的 chaincode 可执行文件。
// =============================================================================

package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"

	"github.com/Chandler0591/chain-field-guard/chaincode/agrichain"
)

func main() {
	chaincode, err := contractapi.NewChaincode(new(agrichain.SmartContract))
	if err != nil {
		log.Panicf("创建链码实例失败: %v", err)
	}
	if err := chaincode.Start(); err != nil {
		log.Panicf("启动链码服务失败: %v", err)
	}
}
