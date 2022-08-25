import AWS from "aws-sdk";
export const getPrivateKey = async (fromEnv: boolean = false) => {
  if (fromEnv) return process.env.PRIVATE_KEY;
  const secretId = process.env.SECRET_NAME;
  if (!secretId) throw Error("No SECRET_ID provided for AWS Secrets Manager");
  const secretsManager = new AWS.SecretsManager();
  const secret = await secretsManager
    .getSecretValue({
      SecretId: secretId,
    })
    .promise();

  return JSON.parse(secret.SecretString!).PRIVATE_KEY;
};
