import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  console.log("Starting backend server...");
  const app = await NestFactory.create(AppModule);

  app.enableCors(); // Allow all origins for local development

  await app.listen(process.env.PORT ?? 3001, '0.0.0.0');
}
bootstrap();
