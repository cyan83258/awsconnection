param(
    [string]$Region = 'us-east-1',
    [string]$BucketName,
    [string]$RoleName = 'bedrock-batch-role',
    [string]$InputPrefix = 'aws-bedrock-bridge/input/',
    [string]$OutputPrefix = 'aws-bedrock-bridge/output/',
    [string]$KmsKeyId
)

$ErrorActionPreference = 'Stop'

function Require-Command {
    param([string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name 명령을 찾지 못했습니다. 먼저 설치하고 로그인 또는 자격 증명 설정을 끝낸 뒤 다시 실행하세요."
    }
}

function Invoke-AwsJson {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & aws @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output | Out-String).Trim()
    }

    if (-not $output) {
        return $null
    }

    return $output | ConvertFrom-Json
}

function Invoke-AwsText {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $output = & aws @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output | Out-String).Trim()
    }

    return (($output | Out-String).Trim())
}

function Ensure-S3Bucket {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$BucketRegion
    )

    $exists = $true
    try {
        Invoke-AwsText -Arguments @('s3api', 'head-bucket', '--bucket', $Name)
    } catch {
        $exists = $false
    }

    if ($exists) {
        Write-Host "S3 bucket already exists: $Name"
        return
    }

    Write-Host "Creating S3 bucket: $Name ($BucketRegion)"
    if ($BucketRegion -eq 'us-east-1') {
        Invoke-AwsText -Arguments @('s3api', 'create-bucket', '--bucket', $Name)
    } else {
        Invoke-AwsText -Arguments @('s3api', 'create-bucket', '--bucket', $Name, '--create-bucket-configuration', "LocationConstraint=$BucketRegion", '--region', $BucketRegion)
    }
}

function Ensure-IamRole {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$TrustPolicyPath
    )

    try {
        $role = Invoke-AwsJson -Arguments @('iam', 'get-role', '--role-name', $Name, '--output', 'json')
        Write-Host "IAM role already exists: $Name"
        return $role.Role.Arn
    } catch {
        Write-Host "Creating IAM role: $Name"
        $created = Invoke-AwsJson -Arguments @('iam', 'create-role', '--role-name', $Name, '--assume-role-policy-document', "file://$TrustPolicyPath", '--output', 'json')
        return $created.Role.Arn
    }
}

function Put-IamRolePolicy {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RoleName,
        [Parameter(Mandatory = $true)]
        [string]$PolicyName,
        [Parameter(Mandatory = $true)]
        [string]$PolicyPath
    )

    Invoke-AwsText -Arguments @('iam', 'put-role-policy', '--role-name', $RoleName, '--policy-name', $PolicyName, '--policy-document', "file://$PolicyPath")
}

Require-Command -Name 'aws'

$callerArn = Invoke-AwsText -Arguments @('sts', 'get-caller-identity', '--query', 'Arn', '--output', 'text')
$accountId = Invoke-AwsText -Arguments @('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text')

if (-not $BucketName) {
    $BucketName = "bedrock-batch-$accountId-$Region"
}

$InputPrefix = $InputPrefix.TrimStart('/')
$OutputPrefix = $OutputPrefix.TrimStart('/')
if (-not $InputPrefix.EndsWith('/')) {
    $InputPrefix += '/'
}
if (-not $OutputPrefix.EndsWith('/')) {
    $OutputPrefix += '/'
}

$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$trustPolicyPath = Join-Path $rootDir 'bedrock-batch-trust-policy.json'
$rolePolicyPath = Join-Path $rootDir 'bedrock-batch-role-policy.json'
$callerPolicyPath = Join-Path $rootDir 'bedrock-batch-caller-policy.json'

$trustPolicy = @{
    Version = '2012-10-17'
    Statement = @(
        @{
            Effect = 'Allow'
            Principal = @{
                Service = 'bedrock.amazonaws.com'
            }
            Action = 'sts:AssumeRole'
        }
    )
} | ConvertTo-Json -Depth 10

$roleStatements = @(
    @{
        Effect = 'Allow'
        Action = @(
            's3:GetObject',
            's3:PutObject',
            's3:AbortMultipartUpload',
            's3:ListBucket'
        )
        Resource = @(
            "arn:aws:s3:::$BucketName",
            "arn:aws:s3:::$BucketName/$InputPrefix*",
            "arn:aws:s3:::$BucketName/$OutputPrefix*"
        )
    },
    @{
        Effect = 'Allow'
        Action = @(
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream'
        )
        Resource = @(
            "arn:aws:bedrock:${Region}::foundation-model/*",
            "arn:aws:bedrock:${Region}:${accountId}:inference-profile/*",
            "arn:aws:bedrock:${Region}:${accountId}:application-inference-profile/*"
        )
    }
)

if ($KmsKeyId) {
    $roleStatements += @{
        Effect = 'Allow'
        Action = @(
            'kms:Encrypt',
            'kms:Decrypt',
            'kms:GenerateDataKey'
        )
        Resource = $KmsKeyId
    }
}

$rolePolicy = @{
    Version = '2012-10-17'
    Statement = $roleStatements
} | ConvertTo-Json -Depth 10

$callerStatements = @(
    @{
        Effect = 'Allow'
        Action = @(
            'bedrock:CreateModelInvocationJob',
            'bedrock:GetModelInvocationJob',
            'bedrock:StopModelInvocationJob',
            'bedrock:ListModelInvocationJobs',
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:ListFoundationModels'
        )
        Resource = '*'
    },
    @{
        Effect = 'Allow'
        Action = @(
            's3:GetObject',
            's3:PutObject',
            's3:ListBucket',
            's3:AbortMultipartUpload'
        )
        Resource = @(
            "arn:aws:s3:::$BucketName",
            "arn:aws:s3:::$BucketName/$InputPrefix*",
            "arn:aws:s3:::$BucketName/$OutputPrefix*"
        )
    }
)

if ($KmsKeyId) {
    $callerStatements += @{
        Effect = 'Allow'
        Action = @(
            'kms:Encrypt',
            'kms:Decrypt',
            'kms:GenerateDataKey'
        )
        Resource = $KmsKeyId
    }
}

$callerPolicy = @{
    Version = '2012-10-17'
    Statement = $callerStatements
} | ConvertTo-Json -Depth 10

Set-Content -LiteralPath $trustPolicyPath -Value $trustPolicy -Encoding UTF8
Set-Content -LiteralPath $rolePolicyPath -Value $rolePolicy -Encoding UTF8
Set-Content -LiteralPath $callerPolicyPath -Value $callerPolicy -Encoding UTF8

Ensure-S3Bucket -Name $BucketName -BucketRegion $Region
$roleArn = Ensure-IamRole -Name $RoleName -TrustPolicyPath $trustPolicyPath
Put-IamRolePolicy -RoleName $RoleName -PolicyName 'bedrock-batch-runtime-policy' -PolicyPath $rolePolicyPath

Write-Host ''
Write-Host '완료. 아래 값을 확장 설정에 입력하면 됩니다.' -ForegroundColor Green
Write-Host "Batch Input S3 Prefix : s3://$BucketName/$InputPrefix"
Write-Host "Batch Output S3 Prefix: s3://$BucketName/$OutputPrefix"
Write-Host "Batch Service Role ARN: $roleArn"
Write-Host ''
Write-Host '중요:' -ForegroundColor Yellow
Write-Host "1. 현재 플러그인에 넣는 AWS Access Key/Secret Key 주체에도 batch/S3 권한이 있어야 합니다."
Write-Host "2. 그 주체에 붙일 최소 권한 JSON을 이 파일로 저장해 뒀습니다: $callerPolicyPath"
Write-Host "3. Batch Output KMS Key ID를 쓸 거면 같은 키 권한도 현재 주체와 service role 둘 다 필요합니다."

Remove-Item -LiteralPath $trustPolicyPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $rolePolicyPath -Force -ErrorAction SilentlyContinue