terraform {
  backend "s3" {
    bucket         = "hms-dev-terraform-state-558215002582-ap-southeast-2"
    key            = "hms/dev/terraform.tfstate"
    region         = "ap-southeast-2"
    dynamodb_table = "hms-dev-terraform-locks"
    encrypt        = true
  }
}
