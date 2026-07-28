import {
  ApiGatewayV2Client,
  CreateDomainNameCommand,
  GetApiCommand,
  GetDomainNameCommand,
  UpdateApiCommand,
  UpdateDomainNameCommand,
} from "@aws-sdk/client-apigatewayv2"


const [apiId, domainName, certificateArn, region] = process.argv.slice(2)

if (![apiId, domainName, certificateArn, region].every(Boolean)) {
  throw new Error("usage: node ensure-dualstack.mjs <api-id> <domain> <certificate-arn> <region>")
}

const client = new ApiGatewayV2Client({ region })
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const readDomain = async () => {
  try {
    return await client.send(new GetDomainNameCommand({ DomainName: domainName }))
  } catch (error) {
    if (error?.name === "NotFoundException") return null
    throw error
  }
}

const domainConfiguration = {
  CertificateArn: certificateArn,
  EndpointType: "REGIONAL",
  IpAddressType: "dualstack",
  SecurityPolicy: "TLS_1_2",
}

const api = await client.send(new GetApiCommand({ ApiId: apiId }))
if (api.IpAddressType !== "dualstack") {
  await client.send(new UpdateApiCommand({ ApiId: apiId, IpAddressType: "dualstack" }))
}

const existingDomain = await readDomain()
if (existingDomain) {
  const current = existingDomain.DomainNameConfigurations?.[0]
  if (current?.IpAddressType !== "dualstack") {
    await client.send(new UpdateDomainNameCommand({
      DomainName: domainName,
      DomainNameConfigurations: [domainConfiguration],
    }))
  }
} else {
  await client.send(new CreateDomainNameCommand({
    DomainName: domainName,
    DomainNameConfigurations: [domainConfiguration],
  }))
}

for (let attempt = 0; attempt < 60; attempt += 1) {
  const domain = await readDomain()
  const configuration = domain?.DomainNameConfigurations?.[0]
  if (configuration?.DomainNameStatus === "AVAILABLE" && configuration?.IpAddressType === "dualstack") {
    console.log("dual-stack API and custom domain ready")
    process.exit(0)
  }
  await pause(5_000)
}

throw new Error("dual-stack custom domain did not become available")
