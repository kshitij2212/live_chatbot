import { classifyTarget } from '../../src/comments/UtteranceTargetFilter.js';

describe('UtteranceTargetFilter.classifyTarget', () => {
  const shivamBotNames = ['shivam', 'Shivam bot'];
  const abhishekBotNames = ['abhishek', 'Abhishek Bot'];

  test('abhishek addressed, shivam referenced as object', () => {
    const text = 'अच्छा तो अभिशेक आप शिवम को जानते हो गया?';
    
    // Abhishek Bot should process it
    const abhishekResult = classifyTarget(text, abhishekBotNames);
    expect(abhishekResult.target).toBe('bot_direct');
    expect(abhishekResult.shouldProcess).toBe(true);

    // Shivam Bot should NOT process it (directed at other person / abhishek)
    const shivamResult = classifyTarget(text, shivamBotNames);
    expect(shivamResult.target).toBe('other_person');
    expect(shivamResult.shouldProcess).toBe(false);
  });

  test('shivam addressed, abhishek referenced as object', () => {
    const text = 'शिवम, अभिषेक को जानते हो क्या?';

    // Shivam Bot should process it
    const shivamResult = classifyTarget(text, shivamBotNames);
    expect(shivamResult.target).toBe('bot_direct');
    expect(shivamResult.shouldProcess).toBe(true);

    // Abhishek Bot should NOT process it
    const abhishekResult = classifyTarget(text, abhishekBotNames);
    expect(abhishekResult.target).toBe('other_person');
    expect(abhishekResult.shouldProcess).toBe(false);
  });

  test('both names are objects in third person instruction', () => {
    const text = 'शिवम को बोलो कि अभिषेक से बात करे';

    // Neither bot should process it
    const shivamResult = classifyTarget(text, shivamBotNames);
    expect(shivamResult.target).toBe('other_person');
    expect(shivamResult.shouldProcess).toBe(false);

    const abhishekResult = classifyTarget(text, abhishekBotNames);
    expect(abhishekResult.target).toBe('other_person');
    expect(abhishekResult.shouldProcess).toBe(false);
  });

  test('neutral mention of both bots default allowed', () => {
    const text = 'शिवम और अभिषेक आ जाओ';

    const shivamResult = classifyTarget(text, shivamBotNames);
    expect(shivamResult.target).toBe('bot_direct');
    expect(shivamResult.shouldProcess).toBe(true);

    const abhishekResult = classifyTarget(text, abhishekBotNames);
    expect(abhishekResult.target).toBe('bot_direct');
    expect(abhishekResult.shouldProcess).toBe(true);
  });

  test('ab sheikh typo transcription addressed', () => {
    const text = 'अब शेख जी क्या आप शिवम को जानते हो?';

    const abhishekResult = classifyTarget(text, abhishekBotNames);
    expect(abhishekResult.target).toBe('bot_direct');
    expect(abhishekResult.shouldProcess).toBe(true);

    const shivamResult = classifyTarget(text, shivamBotNames);
    expect(shivamResult.target).toBe('other_person');
    expect(shivamResult.shouldProcess).toBe(false);
  });
});
