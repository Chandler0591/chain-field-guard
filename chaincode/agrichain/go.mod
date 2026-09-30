// 链田守护(ChainField Guard)联盟链链码
// 模块路径与 GitHub 仓库一致,便于 deployCC 脚本 vendor 后打包。
// 直接依赖仅 contract-api-go;shimtest(单元测试)/protos 等作为其间接依赖
// 由 `go mod tidy` 自动解析固定版本。
module github.com/Chandler0591/chain-field-guard/chaincode/agrichain

go 1.22.0

toolchain go1.22.12

require (
	github.com/hyperledger/fabric-chaincode-go v0.0.0-20230731094759-d626e9ab09b9
	github.com/hyperledger/fabric-contract-api-go v1.2.2
	github.com/hyperledger/fabric-protos-go-apiv2 v0.3.7
	google.golang.org/protobuf v1.36.3
)

require (
	github.com/go-openapi/jsonpointer v0.20.0 // indirect
	github.com/go-openapi/jsonreference v0.20.2 // indirect
	github.com/go-openapi/spec v0.20.9 // indirect
	github.com/go-openapi/swag v0.22.4 // indirect
	github.com/gobuffalo/envy v1.10.2 // indirect
	github.com/gobuffalo/packd v1.0.2 // indirect
	github.com/gobuffalo/packr v1.30.1 // indirect
	github.com/golang/protobuf v1.5.3 // indirect
	github.com/hyperledger/fabric-protos-go v0.3.0 // indirect
	github.com/joho/godotenv v1.5.1 // indirect
	github.com/josharian/intern v1.0.0 // indirect
	github.com/mailru/easyjson v0.7.7 // indirect
	github.com/rogpeppe/go-internal v1.11.0 // indirect
	github.com/xeipuuv/gojsonpointer v0.0.0-20190905194746-02993c407bfb // indirect
	github.com/xeipuuv/gojsonreference v0.0.0-20180127040603-bd5ef7bd5415 // indirect
	github.com/xeipuuv/gojsonschema v1.2.0 // indirect
	golang.org/x/mod v0.17.0 // indirect
	golang.org/x/net v0.34.0 // indirect
	golang.org/x/sys v0.29.0 // indirect
	golang.org/x/text v0.21.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20250115164207-1a7da9e5054f // indirect
	google.golang.org/grpc v1.67.3 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)
