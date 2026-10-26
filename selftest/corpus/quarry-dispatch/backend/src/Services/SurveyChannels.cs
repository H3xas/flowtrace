using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public interface ISurveyChannel
    {
        Task<string> Probe(string serial);
    }

    public class Channel01 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel01:" + serial);
        }
    }

    public class Channel02 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel02:" + serial);
        }
    }

    public class Channel03 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel03:" + serial);
        }
    }

    public class Channel04 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel04:" + serial);
        }
    }

    public class Channel05 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel05:" + serial);
        }
    }

    public class Channel06 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel06:" + serial);
        }
    }

    public class Channel07 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel07:" + serial);
        }
    }

    public class Channel08 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel08:" + serial);
        }
    }

    public class Channel09 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel09:" + serial);
        }
    }

    public class Channel10 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel10:" + serial);
        }
    }

    public class Channel11 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel11:" + serial);
        }
    }

    public class Channel12 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel12:" + serial);
        }
    }

    public class Channel13 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel13:" + serial);
        }
    }

    public class Channel14 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel14:" + serial);
        }
    }

    public class Channel15 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel15:" + serial);
        }
    }

    public class Channel16 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel16:" + serial);
        }
    }

    public class Channel17 : ISurveyChannel
    {
        public Task<string> Probe(string serial)
        {
            return Task.FromResult("channel17:" + serial);
        }
    }

}
