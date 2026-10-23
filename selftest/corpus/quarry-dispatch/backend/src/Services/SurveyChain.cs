using System.Threading.Tasks;

namespace QuarryDispatch.Api.Services
{
    public class SurveyA
    {
        private readonly SurveyB _next;

        public SurveyA(SurveyB next)
        {
            _next = next;
        }

        public Task StepOne(string serial)
        {
            _next.Probe(serial);
            _next.Probe(serial);
            return _next.Probe(serial);
        }

        public Task StepTwo(string serial)
        {
            _next.Probe(serial);
            _next.Probe(serial);
            return _next.Probe(serial);
        }

        public Task StepThree(string serial)
        {
            _next.Probe(serial);
            _next.Probe(serial);
            return _next.Probe(serial);
        }
    }

    public class SurveyB
    {
        private readonly SurveyC _next;

        public SurveyB(SurveyC next)
        {
            _next = next;
        }

        public Task Probe(string serial)
        {
            _next.Probe(serial);
            _next.Probe(serial);
            return _next.Probe(serial);
        }
    }

    public class SurveyC
    {
        private readonly SurveyD _next;

        public SurveyC(SurveyD next)
        {
            _next = next;
        }

        public Task Probe(string serial)
        {
            _next.Probe(serial);
            _next.Probe(serial);
            return _next.Probe(serial);
        }
    }

    public class SurveyD
    {
        public Task Probe(string serial)
        {
            return Task.CompletedTask;
        }
    }
}
