import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { NotionService } from './notion.service';
import type { UserRecord } from '../types/notion-model.types';

export class UserService {
  constructor(private notion: NotionService) {}

  public async authenticate(email: string, password: string): Promise<UserRecord | null> {
    const user = await this.notion.findUserByEmail(email);
    if (!user) return null;

    // if mock mode or no password stored, allow only if password is empty or matches blank
    if (!user.passwordHash) return null;

    const match = await bcrypt.compare(password, user.passwordHash);
    return match ? user : null;
  }

  public createAccessToken(user: UserRecord) {
    const payload = { sub: user.pageId, email: user.email, role: user.role };
    const secret = env.JWT_ACCESS_SECRET || 'changeme';
    return jwt.sign(payload as any, secret as any, { expiresIn: env.ACCESS_TOKEN_TTL as any });
  }

  public async getUserById(userId: string): Promise<UserRecord | null> {
    return this.notion.findUserById(userId);
  }

  public async getLinkedPatientPageIds(userId: string): Promise<string[]> {
    return this.notion.getUserLinkedPatientIds(userId);
  }

  public async registerUser(input: {
    email: string;
    password: string;
    role: string;
    linkedPatientPageIds?: string[];
  }): Promise<UserRecord> {
    const hashedPassword = await bcrypt.hash(input.password, 10);
    // Inspect database properties to build a compatible properties object
    const db = await this.notion.getDatabase(env.DATABASE_ID_USUARIOS);
    const dbProps: Record<string, any> = (db && db.properties) || {};

    const properties: Record<string, unknown> = {};

    // Email: prefer email type, fall back to title or rich_text
    if (dbProps.Email) {
      const t = dbProps.Email.type;
      if (t === 'email') properties.Email = { email: input.email };
      else if (t === 'title') properties.Email = { title: [{ text: { content: input.email } }] };
      else properties.Email = { rich_text: [{ text: { content: input.email } }] };
    }

    // Password_Hash: use rich_text if exists, otherwise create rich_text anyway
    if (dbProps.Password_Hash) {
      properties.Password_Hash = { rich_text: [{ text: { content: hashedPassword } }] };
    }

    // Role: try various property names that may exist
    const roleKey = Object.keys(dbProps).find((k) => k.toLowerCase() === 'rol' || k.toLowerCase() === 'role');
    if (roleKey) {
      const t = dbProps[roleKey].type;
      if (t === 'select' || t === 'multi_select') properties[roleKey] = { select: { name: input.role } };
      else properties[roleKey] = { rich_text: [{ text: { content: input.role } }] };
    }

    // Linked patients: find a relation property that matches patient keyword
    const patientKey = Object.keys(dbProps).find((k) => /pacient|paciente|patient/i.test(k));
    if (patientKey && input.linkedPatientPageIds?.length) {
      if (dbProps[patientKey].type === 'relation') {
        properties[patientKey] = { relation: input.linkedPatientPageIds.map((id) => ({ id })) };
      }
    }

    const page = await this.notion.createPage({
      databaseId: env.DATABASE_ID_USUARIOS,
      properties,
    });

    return this.notion.mapUser(page);
  }

  public async updateProfile(userId: string, data: { name?: string; email?: string }): Promise<UserRecord | null> {
    const properties: Record<string, any> = {};
    if (data.email) {
      properties.Email = { title: [{ text: { content: data.email } }] };
    }
    // Note: In this schema, 'Name' might not exist in the users DB directly, 
    // but we can try to update it if it's there or update the linked patient.
    // For now, let's just update the user record properties that exist.
    
    const page = await this.notion.updatePage({
      pageId: userId,
      properties,
    });
    return this.notion.mapUser(page);
  }

  public async updatePassword(userId: string, newPassword: string): Promise<boolean> {
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.notion.updatePage({
      pageId: userId,
      properties: {
        Password_Hash: { rich_text: [{ text: { content: hashedPassword } }] },
      },
    });
    return true;
  }
}

export default UserService;
